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
import { takeResource } from '../../../../index.js';
import {
  HANDOFF_DISPATCHER_RESOURCE,
  drainHandoffQueue,
  handoffQueueDirectory,
  handoffWorkerCapacity,
  queueHandoffLaunch,
  reserveHandoffTicket,
  withHandoffQueueOrder,
} from '../../../../index.js';
import { waitForCondition } from '../../../../../../apps/cli/tests/fixtures/runner/holders.js';

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

test('a burst of 20 submits with inverted completion and same-clock ids starts in reserved order; nothing spawns until the dispatcher runs, then runs at most N at once in submit order [C7]', async t => {
  const box = fixture(20);
  try {
    const places = [];
    await Promise.all(box.jobs.map(job => withHandoffQueueOrder(async () => { places.push(await reserveHandoffTicket(job.id)); })));
    // Tooling copies finish in the opposite order: places, not completion or clock, set the line.
    for (let index = places.length - 1; index >= 0; index--) {
      const job = box.jobs[index];
      queueHandoffLaunch({ directory: job.directory, tools: box.tools, commonDir: box.dir, job: job.id }, places[index]);
    }
    assert.equal(tickets().length, 20, 'every submit left one launch ticket');
    assert.equal(readFileSync(box.log, 'utf8'), '', 'queueing a launch spawns no worker');
    const N = 3;
    const draining = drainHandoffQueue({ capacity: N });
    let drained;
    try {
      const ready = waitForCondition(() => readFileSync(box.log, 'utf8').split('\n').filter(line => line.startsWith('start ')).length === N,
        'the first wave fills the cap before release', { signal: t.signal });
      await Promise.race([ready, draining.then(() => { throw new Error('dispatcher finished before the held wave reached capacity'); })]);
    } finally { writeFileSync(join(box.dir, 'release'), 'go'); drained = await draining; }
    const { started } = drained;
    assert.deepEqual(started, box.jobs.map(job => job.id), 'workers start in submit order');
    let running = 0;
    let peak = 0;
    const finished = new Set();
    for (const line of readFileSync(box.log, 'utf8').trim().split('\n')) {
      const [event, id] = line.split(' ');
      running += event === 'start' ? 1 : -1;
      if (event === 'end') finished.add(id);
      peak = Math.max(peak, running);
      assert.ok(running <= N, `more than ${N} workers ran at once`);
    }
    assert.equal(peak, N, 'the cap is reached, so the machine is used');
    assert.equal(finished.size, 20, 'all 20 finish');
    assert.deepEqual(tickets(), [], 'the queue has no remaining launch tickets');
    for (const job of box.jobs) assert.deepEqual(JSON.parse(readFileSync(join(job.directory, 'result.json'), 'utf8')), { job: job.id }, 'each real worker retained its own result');
  } finally { box.cleanup(); }
});

test('a dispatcher returns at once while another holds the machine, and starts nothing [C7]', async () => {
  const box = fixture(1);
  try {
    queueHandoffLaunch({ directory: box.jobs[0].directory, tools: box.tools, commonDir: box.dir, job: box.jobs[0].id }, await reserveHandoffTicket(box.jobs[0].id));
    const lock = await takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'other-dispatcher' });
    try {
      assert.deepEqual((await drainHandoffQueue({ capacity: 1 })).started, [], 'the second dispatcher defers to the holder');
      assert.equal(readFileSync(box.log, 'utf8'), '');
      writeFileSync(join(box.dir, 'release'), 'go');
    } finally { lock.release(); }
    assert.deepEqual((await drainHandoffQueue({ capacity: 1 })).started, ['job99'], 'once free, the ticket runs');
  } finally { box.cleanup(); }
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
