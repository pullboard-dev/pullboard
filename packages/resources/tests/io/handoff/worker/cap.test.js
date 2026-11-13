/** The machine runs at most N submit-handoff workers at once and queues the rest unspawned [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  handoffQueueDirectory,
  handoffWorkerCapacity,
  reserveHandoffTicket,
} from '../../../../index.js';

/** A real worker waits for an observable release marker and records its own result, without a timed hold. */
const WORKER = `const { appendFileSync, existsSync, watch, writeFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const directory = dirname(process.argv[2]), id = basename(directory);
const release = join(dirname(dirname(directory)), 'release');
let ended = false;
const watcher = watch(dirname(release), finish);
function finish() {
  if (ended || !existsSync(release)) return;
  ended = true; watcher.close();
  writeFileSync(join(directory, 'result.json'), JSON.stringify({ job: id }));
  appendFileSync(process.env.HANDOFF_TEST_LOG, 'end ' + id + '\\n');
}
appendFileSync(process.env.HANDOFF_TEST_LOG, 'start ' + id + '\\n');
finish();
`;

/** Count launch tickets while retaining the queue's durable counter and other bookkeeping. */
function tickets() { return readdirSync(handoffQueueDirectory()).filter(name => /^\d+-.+\.(json|reserved)$/u.test(name)); }

/** Build a private machine home, a captured tools tree and one job directory per ticket. */
function fixture(count) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-handoff-cap-')));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const jobs = Array.from({ length: count }, (_, index) => {
    const id = `job${String(99 - index)}`;
    const directory = join(dir, 'jobs', id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: id }) + '\n');
    return { id, directory };
  });
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, log: process.env.HANDOFF_TEST_LOG };
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  process.env.HANDOFF_TEST_LOG = log;
  /** Put the environment back and remove the private tree. */
  const cleanup = () => {
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', saved.home], ['HANDOFF_TEST_LOG', saved.log]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, tools, log, jobs, cleanup };
}

test('the worker cap defaults to 4 from cores and honors an override [C7]', () => {
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 16 }), 4);
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 2 }), 2);
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 1 }), 1);
  assert.equal(handoffWorkerCapacity({ env: { PULLBOARD_HANDOFF_WORKERS: '7' }, cores: 2 }), 7);
  assert.throws(() => handoffWorkerCapacity({ env: { PULLBOARD_HANDOFF_WORKERS: '0' } }), error => error.code === 'BAD_HANDOFF_WORKER_CAP');
});

test('registered runner slots raise the worker cap to one per five slots, and the override still wins [C7]', () => {
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 10, runnerSlots: 54 }), 10);
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 10, runnerSlots: 9 }), 4);
  assert.equal(handoffWorkerCapacity({ env: {}, cores: 2, runnerSlots: 0 }), 2);
  assert.equal(handoffWorkerCapacity({ env: { PULLBOARD_HANDOFF_WORKERS: '3' }, cores: 10, runnerSlots: 54 }), 3);
});


test('a damaged durable ticket counter refuses instead of reordering the queue [C7]', async () => {
  const box = fixture(0);
  try {
    mkdirSync(handoffQueueDirectory(), { recursive: true });
    writeFileSync(join(handoffQueueDirectory(), 'next-ticket'), 'damaged');
    await assert.rejects(reserveHandoffTicket('next-job'), { code: 'HANDOFF_TICKET_SOURCE' });
    assert.equal(readFileSync(join(handoffQueueDirectory(), 'next-ticket'), 'utf8'), 'damaged');
    assert.deepEqual(tickets(), []);
  } finally { box.cleanup(); }
});
