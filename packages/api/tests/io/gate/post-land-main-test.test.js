/** A land job that lands a sprint item queues one main-wide test job on the landed tip, which a runner claims; a second receipt for that tip and a steady landing queue none [V2,M1,#12182]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { createJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerLandingJob } from '../../../index.js';
import { provideLandingStart } from '../../../index.js';
import { providePostLandMainTest } from '../../../index.js';
import { provideScreenStart } from '../../../index.js';

const STAMP = '2026-11-19T12:00:00.000Z';
const CONFIG = { trunk: { remote: '/trunk.git' } };
const TRUNK = 'b'.repeat(40);
const REQUEST = { run: ['true'], input: { main: TRUNK, data: { command: 'npm test', files: [] } } };
const landed = ids => ({ version: 1, status: 0, outcome: 'landed', trunk: TRUNK, landed: ids, already: [] });

/** Hand the board a recording request builder (none when `build` is null) and inert starters; all removed when the test ends. */
function builder(t, build = () => ({ needs: [], request: REQUEST })) {
  const calls = [];
  providePostLandMainTest(build && (request => { calls.push(request); return build(request); }));
  provideLandingStart(() => {});
  provideScreenStart(() => ({ state: 'produced', result: { green: false } }));
  t.after(() => { providePostLandMainTest(null); provideLandingStart(null); provideScreenStart(null); });
  return calls;
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

/** The test jobs on the board. */
const testJobs = board => board.db.prepare("SELECT job_id, job_candidate, job_base FROM job WHERE job_kind = 'test'").all().map(row => ({ ...row }));

test('api.gate.post-land-main-test.queues-one: clause 1: a land receipt posted through boardJobQueueCall that lands a sprint item queues one main-wide test job on the landed tip, carrying the land job and its sprint items, and a runner claims it [V2,M1,#12182]', t => {
  const calls = builder(t);
  const fixture = landingBoard(t);
  readyItem(fixture, 7, 'sprint');
  const land = landJob(fixture, [7]);
  assert.deepEqual(land.post(landed([7])).applied?.merged, [7], 'the sprint item lands');
  assert.deepEqual(calls, [{ root: fixture.repo.root, trunk: TRUNK }], 'the builder is asked once, for the landed tip');
  assert.deepEqual(testJobs(fixture.board), [{ job_id: `post-land:${TRUNK}`, job_candidate: TRUNK, job_base: TRUNK }], 'one test job on the landed tip');
  const lease = claimJob(fixture.board.db, { runner: 'r-local', capabilities: [], now: 4 });
  assert.equal(lease?.job, `post-land:${TRUNK}`, 'the runner claims the queued main-wide test job');
  assert.equal(lease.kind, 'test');
  assert.deepEqual(lease.payload?.postLand, { job: land.job, items: [7] }, 'the job carries the land job and the sprint items it landed');
});

test('api.gate.post-land-main-test.once-per-tip: clause 1: a second receipt for the same landed tip, from the same land job or another, queues no second job [V2,M1,#12182]', t => {
  builder(t);
  const fixture = landingBoard(t);
  readyItem(fixture, 7, 'sprint');
  const first = landJob(fixture, [7]);
  first.post(landed([7]));
  first.post(landed([7]));
  readyItem(fixture, 8, 'sprint');
  const second = landJob(fixture, [8]);
  assert.deepEqual(second.post(landed([8])).applied?.merged, [8], 'the second sprint item lands on the same tip');
  assert.equal(testJobs(fixture.board).length, 1, 'one test job for the tip, however many receipts name it');
});

test('api.gate.post-land-main-test.steady-unchanged: clause 2: a land job with only steady items queues no job and prepares the same board calls with a builder as with none, and a board with no builder queues none for a sprint landing [V2,M1,#12182]', t => {
  const run = build => {
    const calls = builder(t, build);
    const fixture = landingBoard(t);
    readyItem(fixture, 7, 'steady');
    const land = landJob(fixture, [7]);
    const apply = prepared(fixture.board, () => land.post(landed([7])));
    assert.deepEqual(apply.value.applied?.merged, [7], 'the verified steady item lands');
    assert.deepEqual(calls, [], 'the builder is never asked for a steady landing');
    assert.deepEqual(testJobs(fixture.board), [], 'a steady landing queues no test job');
    return apply.texts;
  };
  assert.deepEqual(run(undefined), run(null), 'a steady landing prepares the same board calls with a builder as with none');

  builder(t, null);
  const bare = landingBoard(t);
  readyItem(bare, 7, 'sprint');
  assert.deepEqual(landJob(bare, [7]).post(landed([7])).applied?.merged, [7]);
  assert.deepEqual(testJobs(bare.board), [], 'a board with no builder queues no test job');
});
