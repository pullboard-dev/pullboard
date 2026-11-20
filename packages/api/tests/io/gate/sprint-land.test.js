/** A submitted sprint item with a green screen on the trunk tip gets the landing start and is marked merged by its land receipt; steady, red and stale screens get neither [V2,M1,#12176]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { CELL_CONFIG } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { createJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { offerLandingJob } from '../../../index.js';
import { provideLandingStart } from '../../../index.js';
import { provideScreenStart } from '../../../index.js';

const STAMP = '2026-11-19T12:00:00.000Z';
const CONFIG = { trunk: { remote: '/trunk.git' } };
const TRUNK = 'b'.repeat(40);
const OLDER = 'c'.repeat(40);
const LEDGER = { contexts: ['e'.repeat(64)], files: [['web/page.test.js', '1'.repeat(64), 0, 'pass']], omitted: 0 };
const green = head => ({ version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0, ledger: LEDGER }] } });
const LANDED = { version: 1, status: 0, outcome: 'landed', trunk: TRUNK, landed: [7], already: [] };

/** Store a screen receipt as runScreenJob stores one: a screen job whose result step holds the receipt. */
function storeScreen(db, { item, commit, base, green: passed = true }) {
  const id = `screen:${commit}:-@${base}`;
  createJob(db, { id, kind: 'screen', now: 1 });
  writeStep(db, id, 'result', { result: { kind: 'screen', item, commit, digest: null, base, green: passed, trusted: true, leased: true,
    checks: { merge: 'green', static: 'green', secrets: passed ? 'green' : 'red', hooks: 'green' }, findings: passed ? [] : ['secrets: a key'] }, owner: 'fixture' }, { now: 1 });
}

/** Hand the board recording landing and screen starters; the screen starter answers `screened`; both removed when the test ends. */
function recordingStarters(t, screened = { state: 'produced', result: { green: false } }) {
  const landings = [], screens = [];
  provideLandingStart(request => { landings.push(request); });
  provideScreenStart(request => { screens.push(request); return screened; });
  t.after(() => { provideLandingStart(null); provideScreenStart(null); });
  return { landings, screens };
}

/** Let every start the apply queued run: each start waits one immediate, and a screen's landing start one more. */
async function settled() {
  for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve));
}

/** Every SQL text the board prepares while `run` runs, with its answer. */
function prepared(board, run) {
  const prepare = board.db.prepare.bind(board.db);
  const texts = [];
  board.db.prepare = (sql) => { texts.push(sql); return prepare(sql); };
  try { return { texts, value: run() }; } finally { board.db.prepare = prepare; }
}

/** A claimed item frozen under `pace` (steady: none) with a gate job offered for its head, whose trunk tip is that head; post(receipt) answers as the jobs route. */
function pulledSubmit(t, pace) {
  const repo = cellRepo(t, { real: true, config: pace === 'steady' ? CELL_CONFIG : { ...CELL_CONFIG, pace } });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  assert.equal(store.itemPace(held), pace, `the claim froze the ${pace} pace`);
  const head = repo.commit;
  const tree = String(runFixtureGit(['rev-parse', `${head}^{tree}`], { cwd: repo.root }).stdout).trim();
  const job = `gate:${item.item_id}:sprint-land`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-sprint', capabilities: [], now: 2 });
  const post = (receipt) => boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-sprint', token: lease.token, receipt }, { mode: 'pull', now: 3 });
  return { board, id: item.item_id, head, root: repo.root, post };
}

/** Item 7 submitted (frozen at `pace`; steady freezes none) with one land job for it offered against its commit and claimed by a runner. */
function submittedLanding(t, pace) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const commit = repo.commit;
  store.board_ensureCoordinator(board, repo.root);
  const builder = cellSeat(board, { lane: 'core', path: `${repo.root}/seat` }).id;
  board.db.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  board.db.exec('INSERT INTO temp.moving VALUES (1)');
  board.db.prepare(`UPDATE item SET item_status='submitted', item_commit=?, item_owner=?, item_lease_until='2099-01-01T00:00:00.000Z', item_frozen=?, item_frozen_digest=?, item_built_by=? WHERE item_id=7`)
    .run(commit, builder, JSON.stringify(pace === 'steady' ? {} : { pace }), 'd'.repeat(64), builder);
  board.db.exec('DELETE FROM temp.moving');
  const job = offerLandingJob(board.db, { items: [{ id: 7, commit, ref: 'refs/pullboard/land/7' }], expect: commit, config: CONFIG });
  const lease = claimJob(board.db, { runner: 'r-land', capabilities: [], now: 2 });
  assert.equal(lease?.job, job.id, 'the runner pulls the offered land job');
  const post = (receipt) => boardJobQueueCall(board, { action: 'receipt', job: job.id, runner: 'r-land', token: lease.token, receipt }, { mode: 'pull', now: 3 });
  const item = () => ({ ...board.db.prepare('SELECT item_status, item_merged_commit FROM item WHERE item_id = 7').get() });
  return { board, commit, post, item };
}

test('api.gate.sprint-land.start-on-green-screen: clause 1: a green gate receipt for a submitted sprint item with a green screen on the trunk tip calls the landing starter, as for a verified item, and a screen that applies green calls it too [V2,M1,#12176]', async t => {
  const { landings, screens } = recordingStarters(t);
  const ready = pulledSubmit(t, 'sprint');
  storeScreen(ready.board.db, { item: ready.id, commit: ready.head, base: ready.head });
  assert.equal(ready.post(green(ready.head)).applied.outcome, 'review');
  await settled();
  assert.deepEqual(landings, [{ root: ready.root, item: ready.id }], 'the screened sprint item gets the landing start once');
  assert.deepEqual(screens, [], 'a screen already green on the tip is not run again');

  landings.length = 0;
  provideScreenStart(request => { screens.push(request); return { state: 'produced', result: { green: true } }; });
  const fresh = pulledSubmit(t, 'sprint');
  assert.equal(fresh.post(green(fresh.head)).applied.outcome, 'review');
  await settled();
  assert.equal(screens.length, 1, 'the unscreened sprint item gets its screen');
  assert.deepEqual(landings, [{ root: fresh.root, item: fresh.id }], 'the screen that applied green calls the landing starter once');
});

test('api.gate.sprint-land.receipt-marks-merged: clause 1: a landed land receipt marks a submitted sprint item with a green screen on the job\'s trunk merged, where it was skipped as not verified [V2,M1,#12176]', async t => {
  recordingStarters(t);
  const landing = submittedLanding(t, 'sprint');
  storeScreen(landing.board.db, { item: 7, commit: landing.commit, base: landing.commit });
  const answer = landing.post(LANDED);
  assert.deepEqual(answer.applied?.merged, [7], JSON.stringify(answer));
  assert.equal(landing.item().item_merged_commit, TRUNK, 'the sprint item is recorded landed with no accept');
});

test('api.gate.sprint-land.steady-and-stale-unchanged: clause 2: a submitted steady item gets no landing start and is not marked merged, with no screen read; a sprint item with a red screen or a green screen on an older tip gets neither [V2,M1,#12176]', async t => {
  const { landings } = recordingStarters(t);
  const screenReads = texts => texts.filter(sql => sql.includes("j.job_kind = 'screen'"));

  const steady = submittedLanding(t, 'steady');
  storeScreen(steady.board.db, { item: 7, commit: steady.commit, base: steady.commit });
  const steadyLand = prepared(steady.board, () => steady.post(LANDED));
  assert.deepEqual(steadyLand.value.applied?.merged ?? [], [], 'a submitted steady item is not marked merged');
  assert.equal(steady.item().item_merged_commit, null);
  assert.deepEqual(screenReads(steadyLand.texts), [], 'a steady land receipt reads no screen');

  for (const [label, screen] of [['red screen', { green: false }], ['green screen on an older tip', { base: OLDER }]]) {
    const landing = submittedLanding(t, 'sprint');
    storeScreen(landing.board.db, { item: 7, commit: landing.commit, base: landing.commit, ...screen });
    const answer = landing.post(LANDED);
    assert.deepEqual(answer.applied?.merged ?? [], [], `${label}: not marked merged`);
    assert.equal(landing.item().item_merged_commit, null, `${label}: no merged commit`);
  }

  for (const pace of ['steady', 'strict']) {
    const gated = pulledSubmit(t, pace);
    storeScreen(gated.board.db, { item: gated.id, commit: gated.head, base: gated.head });
    const apply = prepared(gated.board, () => gated.post(green(gated.head)));
    assert.equal(apply.value.applied.outcome, 'review');
    assert.deepEqual(screenReads(apply.texts), [], `${pace}: the gate receipt reads no screen`);
  }
  for (const [label, screen] of [['red screen', { green: false }], ['green screen on an older tip', { base: OLDER }]]) {
    const gated = pulledSubmit(t, 'sprint');
    storeScreen(gated.board.db, { item: gated.id, commit: gated.head, base: gated.head, ...screen });
    assert.equal(gated.post(green(gated.head)).applied.outcome, 'review');
  }
  await settled();
  assert.deepEqual(landings, [], 'no steady, strict, red-screened or stale-screened item gets a landing start');
});
