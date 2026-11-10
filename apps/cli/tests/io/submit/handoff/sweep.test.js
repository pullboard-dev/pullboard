/** The hand-off worker-gone sweep survives a replaced agent and keeps sweeping every drain [C7,#3450]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { temporaryDirectory } from '../../../fixtures/board.js';
import { Refused } from '../../../../../../packages/kernel/index.js';
import { drainHandoffQueue } from '../../../../../../packages/resources/index.js';
import { handoffDispatcherLog } from '../../../../../../packages/resources/index.js';
import { queueHandoffLaunch } from '../../../../../../packages/resources/index.js';
import { reserveHandoffTicket } from '../../../../../../packages/resources/index.js';
import { sweepDeadSubmitHandoffs } from '../../../../src/io/submit/handoff.js';
import { waitForCondition } from '../../../fixtures/runner/holders.js';

/** A real worker that stays running until its release file appears, so the drain it belongs to lasts. */
const WORKER = `const { existsSync } = require('node:fs');
const deadline = Date.now() + 120000;
while (!existsSync(process.env.HANDOFF_TEST_RELEASE) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
`;

/** Build a private machine home and a captured tools tree holding the waiting worker. */
function fixture() {
  const dir = realpathSync(temporaryDirectory('pullboard-sweep-replaced-'));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const release = join(dir, 'release');
  const saved = { home: process.env.PULLBOARD_MACHINE_HOME, release: process.env.HANDOFF_TEST_RELEASE };
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  process.env.HANDOFF_TEST_RELEASE = release;
  /** Let any worker end, put the environment back and remove the private tree. */
  const cleanup = () => {
    writeFileSync(release, '');
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', saved.home], ['HANDOFF_TEST_RELEASE', saved.release]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, tools, release, cleanup };
}

/** The dispatcher log text, empty before the first line. */
function dispatcherLog() { return existsSync(handoffDispatcherLog()) ? readFileSync(handoffDispatcherLog(), 'utf8') : ''; }

test('clause 1: an AGENT_REPLACED seat does not stop the sweep: one pass skips the replaced seat\'s hand-off and still recovers the other dead one [C7,#3450]', async () => {
  const errors = [];
  const ctx = { io: { err: line => errors.push(String(line)) } };
  const jobs = [
    { itemId: 2953, job: { id: 'replaced-job', state: 'running', agentId: 'core-1291' } },
    { itemId: 3439, job: { id: 'gone-job', state: 'running', agentId: 'core-1300' } },
  ];
  const recovered = [];
  let infrastructure = 0;
  const recover = async (_ctx, itemId, actor, job) => {
    if (actor === 'core-1291') throw new Refused('AGENT_REPLACED', 'core-1291 was taken over by core-1324 at 2026-11-06T07:24:59.429Z; only pullboard shout --item 2953 "<answer for the incoming agent>" remains available');
    recovered.push({ itemId, actor, job: job.id });
  };
  const looked = await sweepDeadSubmitHandoffs(ctx, { list: () => jobs, recover, recoverInfrastructure: async () => { infrastructure++; }, returnNoVerdict: async () => 0 });
  assert.equal(looked, 2, 'clause 1: the pass looked at both unfinished hand-offs');
  assert.deepEqual(recovered, [{ itemId: 3439, actor: 'core-1300', job: 'gone-job' }], 'clause 1: the other dead hand-off is recovered in the same pass');
  assert.equal(infrastructure, 1, 'clause 1: the pass still reaches infrastructure recovery');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\[HANDOFF_SWEEP\] #2953 skipped: \[AGENT_REPLACED\] core-1291 was taken over by core-1324/u, 'clause 1: the replaced seat\'s hand-off is recorded as skipped');
});

test('clause 1: any other failure is recorded, the rest of the pass still runs, and the sweep then exits non-zero [C7,#3450]', async () => {
  const errors = [];
  const ctx = { io: { err: line => errors.push(String(line)) } };
  const jobs = [
    { itemId: 1, job: { id: 'broken', state: 'queued', agentId: 'core-1' } },
    { itemId: 2, job: { id: 'fine', state: 'queued', agentId: 'core-2' } },
  ];
  const recovered = [];
  const recover = async (_ctx, itemId) => { if (itemId === 1) throw new Refused('SLOT_DB_LOCKED', 'locked'); recovered.push(itemId); };
  await assert.rejects(sweepDeadSubmitHandoffs(ctx, { list: () => jobs, recover, recoverInfrastructure: async () => {}, returnNoVerdict: async () => 0 }), { code: 'SLOT_DB_LOCKED' });
  assert.deepEqual(recovered, [2], 'the second hand-off is recovered before the failure is raised');
  assert.match(errors[0], /^\[HANDOFF_SWEEP\] #1 not recovered: \[SLOT_DB_LOCKED\] locked/u);
});

test('clause 2: a failed pass is retried on the next drain: a sweep that fails while a worker runs is run again before that drain ends [C7,#3450]', async t => {
  const box = fixture();
  try {
    const directory = join(box.dir, 'jobs', 'job1');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'request.json'), JSON.stringify({ job: 'job1' }) + '\n');
    queueHandoffLaunch({ directory, tools: box.tools, commonDir: box.dir, job: 'job1' }, await reserveHandoffTicket('job1'));
    let sweeps = 0;
    const sweep = async () => { sweeps++; if (sweeps === 1) throw new Error('sweep exited 1'); };
    const drained = drainHandoffQueue({ capacity: 1, pollMs: 20, sweep, sweepEveryMs: 50 });
    await waitForCondition(() => sweeps >= 2, 'the failed sweep run again while the worker still runs', { signal: t.signal });
    assert.equal(existsSync(box.release), false, 'clause 2: the retry came inside the same busy drain, before its worker ended');
    assert.match(dispatcherLog(), /worker-gone sweep of .* failed: ERROR sweep exited 1; it runs again on a later pass/u, 'clause 2: the failed sweep is logged');
    writeFileSync(box.release, '');
    assert.deepEqual((await drained).started, ['job1']);
  } finally { box.cleanup(); }
});
