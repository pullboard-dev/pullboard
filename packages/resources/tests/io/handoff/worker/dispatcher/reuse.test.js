/** @pullboard-test-input apps/cli/src/io/gate/drive.js apps/lib/src/io/handoff/dispatcher.js packages/resources/src/io/handoff/worker/detach.js */
/** @pullboard-world-pin: the fixture copies the real detached launcher packages/resources/src/io/handoff/worker/detach.js so the dispatcher starts the way production starts it. */
/** The handoff dispatcher survives a failed slot release at a worker exit, and never trusts a receipt over the lock [C7,#2996]. */
import assert from 'node:assert/strict';
import {
  existsSync,
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
import { Refused } from '../../../../../../kernel/index.js';
import {
  HANDOFF_DISPATCHER_RESOURCE,
  drainHandoffQueue,
  ensureHandoffDispatcher,
  handoffDispatcherLog,
  handoffQueueDirectory,
  queueHandoffLaunch,
  reserveHandoffTicket,
  takeResource,
} from '../../../../../index.js';
import { waitForCondition } from '../../../../../../../apps/cli/tests/fixtures/runner/holders.js';

/** A real worker records when it started and exits at once. */
const WORKER = `import { appendFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
appendFileSync(process.env.HANDOFF_TEST_LOG, basename(dirname(process.argv[2])) + ' ' + Date.now() + '\\n');
`;

/** A stand-in dispatcher entry that records its own pid and exits. The launcher hands a dispatcher a cleaned environment, so the log path is written into the entry. */
const dispatcherSource = log => `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, 'dispatcher ' + process.pid + '\\n');
`;

/** Build a private machine home and a captured tools tree holding a worker and a dispatcher entry. */
function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-dispatcher-reuse-')));
  const tools = join(dir, 'tools');
  for (const folder of ['apps/cli/src/io/gate', 'apps/lib/src/io/handoff', 'packages/resources/src/io/handoff/worker']) mkdirSync(join(tools, folder), { recursive: true });
  // The captured tools are ES modules, and the dispatcher is started through the real detached launcher the production code runs.
  writeFileSync(join(tools, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(tools, 'packages/resources/src/io/handoff/worker/detach.js'), readFileSync(new URL('../../../../../src/io/handoff/worker/detach.js', import.meta.url), 'utf8'));
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const log = join(dir, 'log');
  writeFileSync(join(tools, 'apps/lib/src/io/handoff/dispatcher.js'), dispatcherSource(log));
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

/** Lines the stand-in dispatcher wrote, one per spawn. */
function dispatcherSpawns(box) { return readFileSync(box.log, 'utf8').split('\n').filter(line => line.startsWith('dispatcher ')); }

test('clause 1: a SLOT_DB_LOCKED release at a worker exit is logged and retried, and the waiting ticket starts within 5 s [C7,#2996]', async () => {
  const box = fixture();
  try {
    await queueJob(box, 'job1');
    await queueJob(box, 'job2');
    let failures = 0;
    const { started } = await drainHandoffQueue({
      capacity: 1,
      pollMs: 50,
      releaseSlot(slot) {
        if (failures++ === 0) throw new Refused('SLOT_DB_LOCKED', 'the slot database stayed locked');
        slot.release();
      },
    });
    assert.deepEqual(started, ['job1', 'job2'], 'the dispatcher kept draining past the failed release');
    const at = Object.fromEntries(readFileSync(box.log, 'utf8').trim().split('\n').map(line => line.split(' ')).map(([id, ms]) => [id, Number(ms)]));
    assert.ok(at.job2 - at.job1 < 5_000, `the waiting ticket started ${at.job2 - at.job1} ms after the first worker`);
    assert.ok(failures >= 2, 'the failed release was retried');
    assert.match(readFileSync(handoffDispatcherLog(), 'utf8'), /slot release for job1 failed: SLOT_DB_LOCKED .*retrying/u);
  } finally { box.cleanup(); }
});

test('clause 2: ensureHandoffDispatcher replaces a receipt with an empty start time or a live pid when no dispatcher holds the lock [C7,#2996]', async t => {
  const box = fixture();
  try {
    mkdirSync(handoffQueueDirectory(), { recursive: true });
    const receipt = join(handoffQueueDirectory(), 'dispatcher.json');
    // This test process is alive, so the receipt's pid passes a liveness probe either way.
    writeFileSync(receipt, JSON.stringify({ pid: process.pid, started: '' }) + '\n');
    await ensureHandoffDispatcher(box.tools, box.dir, { startOf: () => 'now' });
    await waitForCondition(() => dispatcherSpawns(box).length === 1, 'an empty started time spawns a dispatcher', { signal: t.signal });
    writeFileSync(receipt, JSON.stringify({ pid: process.pid, started: 'now' }) + '\n');
    await ensureHandoffDispatcher(box.tools, box.dir, { startOf: () => 'now' });
    await waitForCondition(() => dispatcherSpawns(box).length === 2, 'a live, matching pid without the lock spawns a dispatcher', { signal: t.signal });
    assert.ok(existsSync(handoffDispatcherLog()), 'the dispatcher writes its output to the dispatcher log');
    const lock = await takeResource({ name: HANDOFF_DISPATCHER_RESOURCE, capacity: 1, scope: 'machine', agent: 'live-dispatcher' });
    try { await ensureHandoffDispatcher(box.tools, box.dir, { startOf: () => 'now' }); }
    finally { lock.release(); }
    assert.equal(dispatcherSpawns(box).length, 2, 'a held dispatcher lock spawns nothing');
  } finally { box.cleanup(); }
});
