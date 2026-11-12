/** A lapsed gate job whose item moved on, or that made no progress for 20 minutes, ends; no fallback renews it [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import {
  fixtureAdd,
  fixtureHandoffPolicy,
  withFixtureBoard,
} from '../../tests/fixtures/testkit.js';
import { submitHandoff } from '../../../../packages/store/index.js';
import {
  createJob,
  jobView,
  takeJob,
  writeStep,
} from '../../../../packages/jobs/index.js';
import {
  GATE_JOB_NO_PROGRESS_MS,
  lapsedGateJobs,
  reclaimPass,
} from '../../../../packages/drive/index.js';

const NOW = Date.parse('2026-11-09T08:30:00.000Z');

/** The item's hand-off record, read from the fixture's own board. */
function handoffState(boardFile, id) {
  // @pullboard-board-file journey: observe the fixture's hand-off record.
  return withFixtureBoard(boardFile, board => submitHandoff(board, id));
}

/** A gate job left at shard.started with its lease lapsed, its last step `idleMs` before NOW, as the 9 Nov zombies were. */
function zombie(db, id, item, idleMs) {
  const at = NOW - idleMs;
  createJob(db, { id, kind: 'gate', item, candidate: 'a'.repeat(40), now: at - 3_000 });
  for (const [index, name] of ['captured', 'running', 'shard.started'].entries()) writeStep(db, id, name, { shard: 's1' }, { now: at - 2_000 + index * 1_000 });
  assert.equal(takeJob(db, id, 'fallback:next:1', { now: at, leaseMs: 120_000 }).taken, true);
}

/** Run one fallback pass on a real board file, recording which jobs it drove and each job's view after it. */
async function pass(t, build, active, ids) {
  const files = privateFixtureFiles('pullboard-zombie-board-');
  return withFixtureBoard(join(files.root, 'board.sqlite'), async board => {
    build(board.db);
    const driven = [];
    const outcome = await reclaimPass(board.db, { owner: 'fallback:next:2', now: () => NOW, active,
      drive: async (db, job) => { driven.push(job); return { transition: null, phase: 'running', job: jobView(db, job) }; } });
    // Read every view while the board is still open.
    const views = new Map(ids.map(id => [id, jobView(board.db, id)]));
    return { outcome, driven, view: id => views.get(id) };
  });
}

test('clause 1: a lapsed gate job whose item is no longer submitted at its commit ends withdrawn and stale, never driven [C7]', async t => {
  const { driven, view } = await pass(t, db => zombie(db, 'handoff-drive-stale', 2662, 5 * 60_000), () => false, ['handoff-drive-stale']);
  assert.deepEqual(driven, [], 'no fallback driver takes it');
  const job = view('handoff-drive-stale');
  assert.equal(job.step, 'done');
  assert.equal(job.leaseOwner, null, 'its lease is freed');
  const ended = job.steps.find(step => step.name === 'withdrawn').payload;
  assert.equal(ended.stale, true);
  assert.equal(ended.lastStep, 'shard.started');
});

test('clause 2: a lapsed gate job with no progress for 20 minutes ends as infrastructure naming its last step; a recent one is driven [C7]', async t => {
  const { driven, view } = await pass(t, db => {
    zombie(db, 'handoff-drive-idle', 3474, GATE_JOB_NO_PROGRESS_MS + 60_000);
    zombie(db, 'handoff-drive-recent', 3475, 3 * 60_000);
  }, () => true, ['handoff-drive-idle', 'handoff-drive-recent']);
  const idle = view('handoff-drive-idle');
  assert.equal(idle.step, 'done');
  const ended = idle.steps.find(step => step.name === 'ended').payload;
  assert.equal(ended.infrastructure, true);
  assert.equal(ended.lastStep, 'shard.started');
  assert.match(ended.reason, /no step for 21 min after shard\.started/u);
  assert.deepEqual(driven, ['handoff-drive-recent'], 'only the job still making progress is driven');
});

test('clause 3: on a real board, the next `next` call ends a stale job whose item is not submitted [C7]', async t => {
  const helpers = createE2eHelpers();
  let box;
  try { box = helpers.project('true', helpers.sandbox()); }
  catch (error) { helpers.cleanup(); throw error; }
  t.after(() => helpers.cleanup());
  const added = fixtureAdd(box.run, box.repo, 'web', 'Verified long ago', '--specs', 'G1', '--criterion', 'Done.', '--check', 'true', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = JSON.parse(added.out).item.item_id;
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const old = Date.now() - 37 * 3_600_000;
  // @pullboard-board-file journey: leave a 37-hour-old gate job at shard.started, as the 9 Nov zombies were.
  withFixtureBoard(boardFile, board => {
    createJob(board.db, { id: 'handoff-drive-zombie', kind: 'gate', item: id, candidate: 'b'.repeat(40), now: old });
    writeStep(board.db, 'handoff-drive-zombie', 'shard.started', { shard: 's1' }, { now: old });
    takeJob(board.db, 'handoff-drive-zombie', 'fallback:next:1', { now: old, leaseMs: 120_000 });
  });
  const next = (await box.runLocal(box.web, 'next', '--json'));
  assert.equal(next.code, 0, `${next.err}\n${next.out}`);
  // @pullboard-board-file journey: read the job the fallback pass ended.
  const job = withFixtureBoard(boardFile, board => jobView(board.db, 'handoff-drive-zombie'));
  assert.equal(job.step, 'done', 'the job ended on that next call');
  assert.ok(job.steps.some(step => step.name === 'withdrawn' && step.payload.stale === true));
});

test('#4070 clause 1: a lapsed gate job serving a live pre-submit hand-off, its item claimed by the hand-off seat, is never ended stale [C7]', async t => {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  const release = join(box.dir, 'release'), started = join(box.dir, 'started');
  const script = join(box.dir, 'gate.cjs');
  writeFileSync(script, [
    "const fs = require('node:fs');",
    `fs.writeFileSync(${JSON.stringify(started)}, 'started');`,
    ' const deadline = Date.now() + 120000;',
    ` while (!fs.existsSync(${JSON.stringify(release)})) { if (Date.now() > deadline) throw Error('fixture release never arrived'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20); }`,
  ].join('\n'));
  const boardFile = fixtureHandoffPolicy(box, JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')));
  const added = fixtureAdd(box.run, box.repo, 'web', 'Held pre-submit gate', '--specs', 'G1', '--criterion', 'Held.',
    '--check', `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`, '--wait', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id), '--json')).code, 0);
  t.after(async () => {
    writeFileSync(release, 'release\n');
    await helpers.waitFor(() => !['queued', 'running'].includes(handoffState(boardFile, id)?.state), 'held gate finished', 120000); // budget: cleanup ceiling, no timing assertion.
    helpers.cleanup();
  });
  assert.equal(helpers.commitFile(box, box.web, 'web/snapshot.txt', 'held\n', 'feat(web): held candidate [G1]').status, 0);
  assert.equal(JSON.parse((await box.runLocal(box.web, 'submit', String(id), '--no-next', '--json')).out).queued, true);
  await helpers.waitFor(() => existsSync(started), 'the gate is running its held check', 120000); // budget: real worker start ceiling, no timing assertion.
  const handoff = handoffState(boardFile, id);
  assert.ok(['queued', 'running'].includes(handoff.state), 'the hand-off is live while its item stays claimed');
  const old = Date.now() - 37 * 3_600_000;
  // @pullboard-board-file journey: leave a lapsed gate job for the item while its hand-off still runs.
  withFixtureBoard(boardFile, board => {
    createJob(board.db, { id: 'handoff-drive-presubmit', kind: 'gate', item: id, candidate: handoff.commit, now: Date.now() - 60_000 });
    writeStep(board.db, 'handoff-drive-presubmit', 'shard.started', { shard: 's1' }, { now: Date.now() - 60_000 });
    takeJob(board.db, 'handoff-drive-presubmit', 'fallback:next:1', { now: old, leaseMs: 120_000 });
  });
  assert.equal((await box.runLocal(box.web, 'next', '--json')).code, 0);
  // @pullboard-board-file journey: read the job the fallback pass left alone.
  const job = withFixtureBoard(boardFile, board => jobView(board.db, 'handoff-drive-presubmit'));
  assert.equal(job.steps.some(step => step.name === 'withdrawn'), false, 'a gate serving a claimed item under a live hand-off is not stale');
});

test('#4071 clause 1: a lapsed gate-drive job is listed; one whose hand-off ended or whose item left its serving state ends stale, and none is driven [C7]', async t => {
  const { driven, view } = await pass(t, db => {
    for (const [id, item] of [['gate-drive:ended-handoff', 4071], ['gate-drive:live-handoff', 4072]]) {
      createJob(db, { id, kind: 'gate-drive', item, candidate: 'c'.repeat(40), now: NOW - 60_000 });
      writeStep(db, id, 'admitted', { owner: 'gate-driver:x', relaunches: 0 }, { now: NOW - 60_000 });
      assert.equal(takeJob(db, id, 'gate-driver:x', { now: NOW - 60_000, leaseMs: 30_000 }).taken, true);
    }
    assert.deepEqual(lapsedGateJobs(db, { now: NOW }).map(row => row.id).sort(), ['gate-drive:ended-handoff', 'gate-drive:live-handoff'], 'both lapsed gate-drive jobs are listed');
  }, view => view.item === 4072, ['gate-drive:ended-handoff', 'gate-drive:live-handoff']);
  assert.deepEqual(driven, [], 'the fallback never drives a gate-drive job');
  const ended = view('gate-drive:ended-handoff');
  assert.equal(ended.step, 'done');
  assert.equal(ended.steps.find(step => step.name === 'withdrawn').payload.stale, true);
  assert.notEqual(view('gate-drive:live-handoff').step, 'done', 'a gate-drive job still serving its hand-off is left to its worker');
});

test('a submitted item is current at the head its hand-off submitted, not at a gate job\'s composed candidate; such a job is never ended stale [C7]', async t => {
  const helpers = createE2eHelpers();
  const isolated = helpers.sandbox();
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete isolated.env[key];
  let box;
  try { box = helpers.project('true', isolated); }
  catch (error) { helpers.cleanup(); throw error; }
  t.after(() => helpers.cleanup());
  const boardFile = fixtureHandoffPolicy(box, JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8')));
  const added = fixtureAdd(box.run, box.repo, 'web', 'Submitted gate', '--specs', 'G1', '--criterion', 'Passes.', '--check', 'true', '--wait', '--json');
  assert.equal(added.code, 0, `${added.err}\n${added.out}`);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id), '--json')).code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/snapshot.txt', 'done\n', 'feat(web): submitted candidate [G1]').status, 0);
  assert.equal(JSON.parse((await box.runLocal(box.web, 'submit', String(id), '--no-next', '--json')).out).queued, true);
  const status = () => withFixtureBoard(boardFile, board => board.db.prepare('SELECT item_status FROM item WHERE item_id = ?').get(id).item_status);
  await helpers.waitFor(() => status() === 'submitted', 'the gate submitted the item', 120000); // budget: real gate ceiling, no timing assertion.
  const handoff = handoffState(boardFile, id);
  // @pullboard-board-file journey: a lapsed gate job whose candidate is the composed merge, not the submitted head.
  withFixtureBoard(boardFile, board => {
    createJob(board.db, { id: 'handoff-drive-composed', kind: 'gate', item: id, candidate: 'd'.repeat(40), now: Date.now() - 60_000 });
    writeStep(board.db, 'handoff-drive-composed', 'shard.started', { shard: 's1' }, { now: Date.now() - 60_000 });
    takeJob(board.db, 'handoff-drive-composed', 'fallback:next:1', { now: Date.now() - 600_000, leaseMs: 120_000 });
  });
  assert.notEqual('d'.repeat(40), handoff.commit, 'the job candidate differs from the submitted head');
  assert.equal((await box.runLocal(box.web, 'next', '--json')).code, 0);
  // @pullboard-board-file journey: read the job the fallback pass judged.
  const job = withFixtureBoard(boardFile, board => jobView(board.db, 'handoff-drive-composed'));
  assert.equal(job.steps.some(step => step.name === 'withdrawn'), false, 'a job for an item submitted at its hand-off head is not stale');
});
