/** A land job that lands sprint items queues one review job for each, once; steady landings queue none; reserving still works [C7,#12503]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { createJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';
import { reserveReview } from '../../../../jobs/index.js';
import { reviewOffer } from '../../../../jobs/index.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerLandingJob } from '../../../index.js';
import { provideLandingStart } from '../../../index.js';
import { provideScreenStart } from '../../../index.js';

const STAMP = '2026-11-19T12:00:00.000Z';
const CONFIG = { trunk: { remote: '/trunk.git' } };
const TRUNK = 'b'.repeat(40);
const landed = ids => ({ version: 1, status: 0, outcome: 'landed', trunk: TRUNK, landed: ids, already: [] });

/** Inert landing and screen starters, removed when the test ends. */
function starters(t) {
  provideLandingStart(() => {});
  provideScreenStart(() => ({ state: 'produced', result: { green: false } }));
  t.after(() => { provideLandingStart(null); provideScreenStart(null); });
}

/** Every SQL text the board prepares while `run` runs, with its answer. */
function prepared(board, run) {
  const prepare = board.db.prepare.bind(board.db);
  const texts = [];
  board.db.prepare = (sql) => { texts.push(sql); return prepare(sql); };
  try { return { texts, value: run() }; } finally { board.db.prepare = prepare; }
}

/** A board with a real repository whose items land at its commit. */
function landingBoard(t) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  store.board_ensureCoordinator(board, repo.root);
  const builderSeat = cellSeat(board, { lane: 'core', path: `${repo.root}/seat` }).id;
  return { board, repo, commit: repo.commit, builderSeat };
}

/** Item `id` at the board's commit: a submitted sprint item with a green screen on that commit, or a verified steady one. */
function readyItem({ board, commit, builderSeat }, id, pace) {
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (?, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(id, STAMP, STAMP);
  if (pace !== 'sprint') {
    board.db.prepare(`INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at)
      VALUES (?, 'core-2', 'ACCEPT', 'CRITERION_MET', 'fixture', ?, ?, ?, ?)`).run(id, commit, 'd'.repeat(64), commit, STAMP);
  }
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status=?, item_commit=?, item_owner=?, item_lease_until='2099-01-01T00:00:00.000Z', item_frozen=?, item_frozen_digest=?, item_built_by=?, item_verified_by=?, item_verdict=? WHERE item_id=?`)
    .run(pace === 'sprint' ? 'submitted' : 'verified', commit, builderSeat, JSON.stringify(pace === 'sprint' ? { pace } : {}), 'd'.repeat(64), builderSeat, pace === 'sprint' ? null : 'core-2', pace === 'sprint' ? null : 'ACCEPT', id);
  board.db.exec('DELETE FROM temp.moving');
  if (pace !== 'sprint') return;
  const screen = `screen:${commit}:-@${commit}:${id}`;
  createJob(board.db, { id: screen, kind: 'screen', now: 1 });
  writeStep(board.db, screen, 'result', { result: { kind: 'screen', item: id, commit, digest: null, base: commit, green: true, trusted: true, leased: true,
    checks: { merge: 'green', static: 'green', secrets: 'green', hooks: 'green' }, findings: [] }, owner: 'fixture' }, { now: 1 });
}

/** Offer one land job for `ids` at the board's commit, claimed by a runner; post(receipt) answers as the jobs route. */
function landJob({ board, commit }, ids) {
  const job = offerLandingJob(board.db, { items: ids.map(id => ({ id, commit, ref: `refs/pullboard/land/${id}` })), expect: commit, config: CONFIG });
  const lease = claimJob(board.db, { runner: 'r-land', capabilities: [], kinds: ['land'], now: 2 });
  assert.equal(lease?.job, job.id, 'the runner pulls the offered land job');
  return { job: job.id, post: receipt => boardJobQueueCall(board, { action: 'receipt', job: job.id, runner: 'r-land', token: lease.token, receipt }, { mode: 'pull', now: 3 }) };
}

/** The review jobs on the board: id, kind, step, lease owner. */
const reviewJobs = board => board.db.prepare("SELECT job_id, job_kind, job_lease_owner FROM job WHERE job_kind = 'review' ORDER BY job_id").all().map(row => ({ ...row }));

test('api.gate.landed-review.one-per-sprint-item: clause 1: a land receipt that lands sprint items 1, 2 and 3 queues one review job for each, review:<item> of kind review in step queued [C7,#12503]', t => {
  starters(t);
  const fixture = landingBoard(t);
  for (const id of [1, 2, 3]) readyItem(fixture, id, 'sprint');
  const land = landJob(fixture, [1, 2, 3]);
  assert.deepEqual(land.post(landed([1, 2, 3])).applied?.merged, [1, 2, 3], 'the three sprint items land');
  assert.deepEqual(reviewJobs(fixture.board), [1, 2, 3].map(id => ({ job_id: `review:${id}`, job_kind: 'review', job_lease_owner: null })), 'one review job per landed sprint item');
  for (const id of [1, 2, 3]) assert.equal(reviewOffer(fixture.board.db, id).offered, true, `review ${id} is offered`);
});

test('api.gate.landed-review.steady-none: clause 1: a landing of steady items queues no review job and prepares no board call a landing with no review queue would not [C7,#12503]', t => {
  starters(t);
  const fixture = landingBoard(t);
  readyItem(fixture, 7, 'steady');
  const land = landJob(fixture, [7]);
  const apply = prepared(fixture.board, () => land.post(landed([7])));
  assert.deepEqual(apply.value.applied?.merged, [7], 'the verified steady item lands');
  assert.deepEqual(reviewJobs(fixture.board), [], 'a steady landing queues no review job');
  assert.equal(apply.texts.filter(sql => /\bjob\b/i.test(sql) && /review/i.test(sql)).length, 0, 'no review job statement is prepared for a steady landing');
});

test('api.gate.landed-review.once: clause 1: a second receipt makes no second review job and leaves a job a reviewer has reserved as it is [C7,#12503]', t => {
  starters(t);
  const fixture = landingBoard(t);
  readyItem(fixture, 7, 'sprint');
  const first = landJob(fixture, [7]);
  first.post(landed([7]));
  assert.deepEqual(reserveReview(fixture.board.db, 7, 'core-2', { now: Date.now() }), { reserved: true, holder: 'core-2' });
  first.post(landed([7]));
  readyItem(fixture, 8, 'sprint');
  landJob(fixture, [8]).post(landed([8]));
  assert.deepEqual(reviewJobs(fixture.board), [{ job_id: 'review:7', job_kind: 'review', job_lease_owner: 'core-2' }, { job_id: 'review:8', job_kind: 'review', job_lease_owner: null }], 'one job per item and the reserved lease stays');
});

test('api.gate.landed-review.reserve-after-queued: clause 2: reserveReview on an item that already holds its queued review job takes the lease, and the landed sprint item is still offered before it [C7,#12503]', t => {
  starters(t);
  const fixture = landingBoard(t);
  readyItem(fixture, 7, 'sprint');
  landJob(fixture, [7]).post(landed([7]));
  assert.equal(reviewOffer(fixture.board.db, 7).offered, true, 'the landed sprint item is offered');
  assert.deepEqual(reserveReview(fixture.board.db, 7, 'core-2', { now: Date.now() }), { reserved: true, holder: 'core-2' });
  assert.equal(reviewOffer(fixture.board.db, 7).offered, false, 'the lease now holds it');
});
