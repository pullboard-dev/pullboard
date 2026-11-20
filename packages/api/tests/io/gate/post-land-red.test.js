/** A red main-wide test receipt after a sprint landing reopens the items its land job landed through the reopen table, whose row pull-out-red writes pull_out; a green one and a steady landing change nothing [M2,R3,#12183]. */
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

const FAILING = { file: 'packages/api/tests/io/gate/fixture-broken.test.js', name: 'api.fixture.broken: clause 1: the landed change breaks it' };
const red = { version: 1, status: 1, outcome: 'red', gate: { green: false, phases: [{ status: 1, failures: [FAILING] }] } };
const green = { version: 1, status: 0, outcome: 'green', gate: { green: true, phases: [{ status: 0, failures: [] }] } };

/** Land sprint item 7 through a land receipt, then claim the main-wide test job it queued; post(receipt) answers as the jobs route. */
function landedSprint(t) {
  builder(t);
  const fixture = landingBoard(t);
  readyItem(fixture, 7, 'sprint');
  assert.deepEqual(landJob(fixture, [7]).post(landed([7])).applied?.merged, [7], 'the sprint item lands');
  const lease = claimJob(fixture.board.db, { runner: 'r-local', capabilities: [], now: 4 });
  assert.equal(lease?.job, `post-land:${TRUNK}`, 'the runner claims the main-wide test job');
  const post = receipt => boardJobQueueCall(fixture.board, { action: 'receipt', job: lease.job, runner: 'r-local', token: lease.token, receipt }, { mode: 'pull', now: 5 });
  return { ...fixture, post };
}

/** The landing events of item `id`, oldest first. */
const kinds = (board, id) => store.events(board, { itemId: id }).map(event => event.event_kind).filter(kind => ['reopen', 'pull_out', 'pulled'].includes(kind));

test('api.gate.post-land-red.pull-out-red-fires: clause 1: a red receipt of the main-wide test job posted through boardJobQueueCall reopens the sprint item its land job landed through the reopen writer, so the reopen table row pull-out-red writes a pull_out naming the failing case [M2,R3,#12183]', t => {
  const fixture = landedSprint(t);
  const merged = store.getItem(fixture.board, 7).item_merged_commit;
  assert.ok(merged, 'the landed item carries its merge commit');
  fixture.post(red);
  assert.equal(store.getItem(fixture.board, 7).item_status, 'open', 'the item goes back to its builder');
  assert.deepEqual(kinds(fixture.board, 7), ['reopen', 'pull_out'], 'one reopen, then the pull_out the pull-out-red row writes');
  const pullOut = JSON.parse(store.events(fixture.board, { itemId: 7 }).findLast(event => event.event_kind === 'pull_out').event_detail);
  assert.equal(pullOut.reason, 'GATE_RED');
  assert.equal(pullOut.mergedCommit, merged, 'the pull_out names the landed merge commit');
  assert.ok(JSON.stringify(pullOut.failure ?? null).includes(`${FAILING.file}: ${FAILING.name}`), 'the pull_out names the failing case from the receipt');
  assert.equal(store.pullingLanding(fixture.board, 7)?.mergedCommit, merged, 'the landing is pulling, which the landing wake turns into a pull-out job');
});

test('api.gate.post-land-red.green-changes-nothing: clause 1: a green receipt of the main-wide test job leaves the landed sprint item submitted and merged, with no reopen and no pull_out [M2,R3,#12183]', t => {
  const fixture = landedSprint(t);
  const before = store.getItem(fixture.board, 7);
  fixture.post(green);
  const after = store.getItem(fixture.board, 7);
  assert.equal(after.item_status, 'submitted');
  assert.equal(after.item_merged_commit, before.item_merged_commit);
  assert.deepEqual(kinds(fixture.board, 7), [], 'no reopen and no pull_out');
});

test('api.gate.post-land-red.steady-unchanged: clause 2: a steady landing queues no main-wide test job, and a plain test job receipt applies with no post-land board call [M2,R3,#12183]', t => {
  builder(t);
  const fixture = landingBoard(t);
  readyItem(fixture, 7, 'steady');
  assert.deepEqual(landJob(fixture, [7]).post(landed([7])).applied?.merged, [7], 'the verified steady item lands');
  assert.deepEqual(testJobs(fixture.board), [], 'a steady landing queues no test job');
  createJob(fixture.board.db, { id: 'plain-test', kind: 'test', now: 4 });
  writeStep(fixture.board.db, 'plain-test', 'offered', { needs: [] }, { now: 4 });
  const lease = claimJob(fixture.board.db, { runner: 'r-local', capabilities: [], now: 5 });
  assert.equal(lease?.job, 'plain-test', 'the runner claims the plain test job');
  const apply = prepared(fixture.board, () => boardJobQueueCall(fixture.board, { action: 'receipt', job: lease.job, runner: 'r-local', token: lease.token, receipt: red }, { mode: 'pull', now: 6 }));
  assert.deepEqual(apply.texts.filter(sql => /job_step_name = .offered. ORDER BY job_step_id LIMIT 1/u.test(sql)), [], 'a plain test receipt reads no post-land offer');
  assert.deepEqual(kinds(fixture.board, 7), [], 'the steady item takes no reopen and no pull_out');
});
