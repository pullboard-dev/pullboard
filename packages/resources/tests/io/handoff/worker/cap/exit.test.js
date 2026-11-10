/** A submit worker that recorded its result exits within a bound, and its freed slot starts the next ticket [C7,#2988]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  drainHandoffQueue,
  queueHandoffLaunch,
  reserveHandoffTicket,
  withHandoffQueueOrder,
} from '../../../../../index.js';
import { HANDOFF_RESULT_GRACE_MS } from '../../../../../src/io/handoff/worker/cap.js';

/**
 * A real worker process: a job named green or red writes that result file, then waits forever like a runner wait
 * on a dead host, ending itself after 30 s so a red run strands nothing; it logs the stop it receives, as the supervisor forwards one to its child. Other jobs just end.
 */
const WORKER = `const { appendFileSync, writeFileSync } = require('node:fs');
const { basename, dirname, join } = require('node:path');
const directory = dirname(process.argv[2]), id = basename(directory);
const log = line => appendFileSync(process.env.HANDOFF_TEST_LOG, line + ' ' + id + ' ' + Date.now() + '\\n');
log('start');
const result = { green: 'submission.json', red: 'refusal.json' }[id.split('-')[0]];
if (result) {
  process.on('SIGTERM', () => { log('stopped'); process.exit(143); });
  writeFileSync(join(directory, result), '{}\\n');
  log('result');
  setTimeout(() => process.exit(1), 30_000);
}
`;

/** Build a private machine home, a captured tools tree and one job directory per id. */
function fixture(ids) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-handoff-exit-')));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const log = join(dir, 'log');
  writeFileSync(log, '');
  const jobs = ids.map(id => {
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

/** The time of one logged event for one job. */
function at(box, event, id) {
  const line = readFileSync(box.log, 'utf8').split('\n').find(row => row.startsWith(`${event} ${id} `));
  assert.ok(line, `${id} logged ${event}`);
  return Number(line.split(' ')[2]);
}

test('the shipped grace plus the kill escalation stays under 2 minutes [C7,#2988]', () => {
  assert.ok(HANDOFF_RESULT_GRACE_MS + 10_000 <= 120_000, 'a worker past its result is gone within 2 minutes');
});

test('a worker that recorded its green or red result and then waits on a runner exits within the grace, and the next ticket starts within 5 s of its release [C7,#2988]', async () => {
  const box = fixture(['green-1', 'red-1', 'next-1']);
  try {
    for (const job of box.jobs) {
      await withHandoffQueueOrder(async () => queueHandoffLaunch({ directory: job.directory, tools: box.tools, commonDir: box.dir, job: job.id }, await reserveHandoffTicket(job.id)));
    }
    const graceMs = 400;
    const { started } = await drainHandoffQueue({ capacity: 1, pollMs: 50, resultGraceMs: graceMs });
    assert.deepEqual(started, ['green-1', 'red-1', 'next-1'], 'every ticket ran in order with one slot');
    for (const id of ['green-1', 'red-1']) {
      const stoppedAfter = at(box, 'stopped', id) - at(box, 'result', id);
      assert.ok(stoppedAfter >= graceMs && stoppedAfter < graceMs + 2_000, `${id} stopped ${stoppedAfter} ms after its result`);
    }
    assert.ok(at(box, 'start', 'red-1') - at(box, 'stopped', 'green-1') < 5_000, 'the freed slot starts the next ticket within 5 s');
    assert.ok(at(box, 'start', 'next-1') - at(box, 'stopped', 'red-1') < 5_000, 'the freed slot starts the next ticket within 5 s');
  } finally { box.cleanup(); }
});
