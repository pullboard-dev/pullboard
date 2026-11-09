/** A lapsed gate job whose item moved on, or that made no progress for 20 minutes, ends; no fallback renews it [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from './fixture-child.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { fixtureAdd, withFixtureBoard } from './testkit-fixture.js';
import { createJob, jobView, takeJob, writeStep } from '../packages/jobs/index.js';
import { GATE_JOB_NO_PROGRESS_MS, reclaimPass } from '../packages/drive/index.js';

const NOW = Date.parse('2026-11-09T08:30:00.000Z');

/** A gate job left at shard.started with its lease lapsed, its last step `idleMs` before NOW, as the 9 Nov zombies were. */
function zombie(db, id, item, idleMs) {
  const at = NOW - idleMs;
  createJob(db, { id, kind: 'gate', item, candidate: 'a'.repeat(40), now: at - 3_000 });
  for (const [index, name] of ['captured', 'running', 'shard.started'].entries()) writeStep(db, id, name, { shard: 's1' }, { now: at - 2_000 + index * 1_000 });
  assert.equal(takeJob(db, id, 'fallback:next:1', { now: at, leaseMs: 120_000 }).taken, true);
}

/** Run one fallback pass on a real board file, failing if it drives a job it should have ended. */
async function pass(t, build, active) {
  const files = privateFixtureFiles('pullboard-zombie-board-');
  return withFixtureBoard(join(files.root, 'board.sqlite'), async board => {
    build(board.db);
    const driven = [];
    const outcome = await reclaimPass(board.db, { owner: 'fallback:next:2', now: () => NOW, active,
      drive: async (db, job) => { driven.push(job); return { transition: null, phase: 'running', job: jobView(db, job) }; } });
    return { outcome, driven, view: id => jobView(board.db, id) };
  });
}

test('clause 1: a lapsed gate job whose item is no longer submitted at its commit ends withdrawn and stale, never driven [C7]', async t => {
  const { driven, view } = await pass(t, db => zombie(db, 'handoff-drive-stale', 2662, 60_000), () => false);
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
  }, () => true);
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
  const next = box.run(box.web, 'next', '--json');
  assert.equal(next.code, 0, `${next.err}\n${next.out}`);
  // @pullboard-board-file journey: read the job the fallback pass ended.
  const job = withFixtureBoard(boardFile, board => jobView(board.db, 'handoff-drive-zombie'));
  assert.equal(job.step, 'done', 'the job ended on that next call');
  assert.ok(job.steps.some(step => step.name === 'withdrawn' && step.payload.stale === true));
});
