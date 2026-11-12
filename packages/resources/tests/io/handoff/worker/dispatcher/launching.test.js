/** A handoff dispatcher with queued tickets and free capacity keeps launching through slot-pool errors, and logs when it launched nothing for too long [C7,#3326]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory } from '../../../../../../../apps/cli/tests/fixtures/board.js';
import { test } from 'node:test';
import { Refused } from '../../../../../../kernel/index.js';
import {
  drainHandoffQueue,
  handoffDispatcherLog,
  queueHandoffLaunch,
  reserveHandoffTicket,
  takeResource,
} from '../../../../../index.js';
import { waitForCondition } from '../../../../../../../apps/cli/tests/fixtures/runner/holders.js';

/** A real worker that records its job directory name and exits at once. */
const WORKER = `const { appendFileSync } = require('node:fs');
const { basename, dirname } = require('node:path');
appendFileSync(process.env.HANDOFF_TEST_LOG, basename(dirname(process.argv[2])) + '\\n');
`;

/** Build a private machine home and a captured tools tree holding a worker. */
function fixture() {
  const dir = realpathSync(temporaryDirectory('pullboard-keeps-launching-'));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const log = join(dir, 'log');
  writeFileSync(log, '');
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
  return { dir, tools, log, cleanup };
}

/** Queue one launch ticket for a fresh job directory. */
async function queueJob(box, id) {
  const directory = join(box.dir, 'jobs', id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: id }) + '\n');
  queueHandoffLaunch({ directory, tools: box.tools, commonDir: box.dir, job: id }, await reserveHandoffTicket(id));
}

/** The jobs the stand-in worker has recorded so far. */
function launched(box) { return readFileSync(box.log, 'utf8').split('\n').filter(Boolean); }

/** The dispatcher log text, empty before the first line. */
function dispatcherLog() { return existsSync(handoffDispatcherLog()) ? readFileSync(handoffDispatcherLog(), 'utf8') : ''; }

test('clause 1: SLOT_DB_LOCKED and BAD_RESOURCE_CAPACITY during a drain pass are retried on the next pass and every queued ticket still launches [C7,#3326]', async t => {
  const box = fixture();
  try {
    await queueJob(box, 'job1');
    await queueJob(box, 'job2');
    const errors = [new Refused('SLOT_DB_LOCKED', 'the slot database stayed locked'), new Refused('BAD_RESOURCE_CAPACITY', 'resource capacity must be positive'), new Refused('SLOT_DB_LOCKED', 'locked again')];
    let calls = 0;
    const takeSlot = options => { if (calls < errors.length) throw errors[calls++]; return takeResource(options); };
    const drained = drainHandoffQueue({ capacity: 2, pollMs: 20, takeSlot });
    await waitForCondition(() => launched(box).length === 2, 'both queued tickets launched after the slot errors', { signal: t.signal });
    assert.deepEqual((await drained).started, ['job1', 'job2']);
    assert.equal(calls, 3, 'every injected slot error was met and survived');
    assert.match(dispatcherLog(), /worker slot not taken: SLOT_DB_LOCKED .*retrying on the next pass/u);
    assert.match(dispatcherLog(), /worker slot not taken: BAD_RESOURCE_CAPACITY .*retrying on the next pass/u);
  } finally { box.cleanup(); }
});

test('clause 1: a capacity function that throws or returns a bad number costs one pass at most, never the dispatcher [C7,#3326]', async t => {
  const box = fixture();
  try {
    await queueJob(box, 'job1');
    await queueJob(box, 'job2');
    const reads = [() => { throw new Refused('SLOT_DB_LOCKED', 'settings locked'); }, () => Number.NaN];
    let pass = 0;
    const capacity = () => (pass < reads.length ? reads[pass++]() : 2);
    const drained = drainHandoffQueue({ capacity, pollMs: 20 });
    await waitForCondition(() => launched(box).length === 2, 'both tickets launched after the bad capacity reads', { signal: t.signal });
    assert.deepEqual((await drained).started, ['job1', 'job2']);
    assert.match(dispatcherLog(), /worker cap unreadable: SLOT_DB_LOCKED/u);
    assert.match(dispatcherLog(), /worker cap NaN is not a whole number/u);
  } finally { box.cleanup(); }
});

test('clause 2: a dispatcher with queued tickets and no worker running logs why it launched nothing after the stall time, then launches [C7,#3326]', async t => {
  const box = fixture();
  try {
    await queueJob(box, 'job1');
    let broken = true;
    const takeSlot = options => { if (broken) throw new Refused('SLOT_DB_LOCKED', 'the slot database stayed locked'); return takeResource(options); };
    const drained = drainHandoffQueue({ capacity: 1, pollMs: 20, stallMs: 300, takeSlot });
    await waitForCondition(() => /no worker launched for \d+s with 1 queued and cap 1; last slot error SLOT_DB_LOCKED/u.test(dispatcherLog()), 'the stall is logged with its cause', { signal: t.signal });
    assert.deepEqual(launched(box), [], 'nothing launched while the slot pool kept failing');
    broken = false;
    await waitForCondition(() => launched(box).length === 1, 'the ticket launched on the pass after the pool recovered', { signal: t.signal });
    assert.deepEqual((await drained).started, ['job1']);
  } finally { box.cleanup(); }
});
