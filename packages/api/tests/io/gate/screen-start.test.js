/** A green pulled gate that records a sprint item's submission calls the screen starter the board was handed; steady and strict call nothing [V2,M1,#12174]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { CELL_CONFIG } from '../../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { jobView } from '../../../../jobs/index.js';
import { leasedJobs } from '../../../../jobs/index.js';
import { reclaimLapsed } from '../../../../jobs/index.js';
import { runScreenJob } from '../../../../drive/index.js';
import * as store from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';
import { provideScreenStart } from '../../../index.js';

/** A claimed item, its bar frozen under `pace` (steady: none), with a gate job offered for its head; post(receipt) answers as the jobs route. */
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
  const job = `gate:${item.item_id}:screen`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-screen', capabilities: [], now: 2 });
  const post = (receipt) => boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-screen', token: lease.token, receipt }, { mode: 'pull', now: 3 });
  return { board, id: item.item_id, head, root: repo.root, post };
}

const LEDGER = { contexts: ['e'.repeat(64)], files: [['web/page.test.js', '1'.repeat(64), 0, 'pass']], omitted: 0 };
const green = head => ({ version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0, ledger: LEDGER }] } });
/** The starter runs after the receipt's writes, on the next turn of the event loop, as the landing starter does. */
const settled = () => new Promise(resolve => setImmediate(resolve));

/** Hand the board a starter that records each call; removed when the test ends. */
function recordingStarter(t) {
  const calls = [];
  provideScreenStart(request => { calls.push(request); });
  t.after(() => provideScreenStart(null));
  return calls;
}

/** Count the board statements prepared while `run` runs. */
function statements(board, run) {
  const prepare = board.db.prepare.bind(board.db);
  let count = 0;
  board.db.prepare = (sql) => { count += 1; return prepare(sql); };
  try { const value = run(); return { count, value }; } finally { board.db.prepare = prepare; }
}

test('api.gate.screen-start.sprint-submit-starts-screen: clause 1: a green gate receipt posted through boardJobQueueCall that records a sprint item\'s submission calls the screen starter once with the item, its commit and the trunk tip [V2,M1,#12174]', async t => {
  const calls = recordingStarter(t);
  const { board, id, head, root, post } = pulledSubmit(t, 'sprint');
  const posted = post(green(head));
  assert.equal(posted.applied.outcome, 'review', JSON.stringify(posted.applied));
  assert.equal(store.getItem(board, id).item_status, 'submitted');
  await settled();
  assert.deepEqual(calls, [{ root, item: id, commit: head, digest: store.getItem(board, id).item_frozen_digest, trunk: head }], 'exactly one screen start for the submitted sprint item');
});

test('api.gate.screen-start.steady-unchanged: clause 2: a steady or strict item, or a board handed no starter, starts no screen, and the receipt apply prepares the same board statements [V2,M1,#12174]', async t => {
  const counts = {};
  for (const pace of ['steady', 'strict']) {
    const calls = recordingStarter(t);
    const { board, head, post } = pulledSubmit(t, pace);
    const run = statements(board, () => post(green(head)));
    assert.equal(run.value.applied.outcome, 'review');
    await settled();
    assert.deepEqual(calls, [], `${pace}: no screen start`);
    counts[pace] = run.count;
  }
  provideScreenStart(null);
  const bare = pulledSubmit(t, 'sprint');
  assert.equal(bare.post(green(bare.head)).applied.outcome, 'review', 'with no starter the sprint submission is recorded as before');
  // The pace is read from the item row the apply already loads: a steady apply with no starter prepares the statements one with a starter does.
  const plain = pulledSubmit(t, 'steady');
  const run = statements(plain.board, () => plain.post(green(plain.head)));
  await settled();
  assert.equal(run.count, counts.steady, 'no board statement is added for a steady item');
});

/** Run the screen a start request names through runScreenJob, as `pullboard serve` does, under driver `owner`. */
const screenFor = (board, request, owner) => runScreenJob(board.db, { repo: request.root,
  item: { id: request.item, pace: 'sprint', commit: request.commit, digest: request.digest }, base: request.trunk, owner, recheck: () => [] });

/** Hand the board the start `pullboard serve` hands in: run the screen through runScreenJob on the board's own handle. */
function servingStarter(t, board) {
  const runs = [];
  provideScreenStart(request => {
    const ran = screenFor(board, request, 'serve:fixture');
    runs.push(ran);
    return ran;
  });
  t.after(() => provideScreenStart(null));
  return runs;
}

/** A sprint submission whose gate receipt starts a real screen job; resolves with the board and that job's id. */
async function screenedSubmit(t) {
  const { board, id, head, root, post } = pulledSubmit(t, 'sprint');
  const runs = servingStarter(t, board);
  assert.equal(post(green(head)).applied.outcome, 'review');
  await settled();
  assert.equal(runs.length, 1, 'the receipt started one screen');
  const ran = await runs[0];
  assert.equal(ran.state, 'produced', JSON.stringify(ran));
  const request = { root, item: id, commit: head, digest: store.getItem(board, id).item_frozen_digest, trunk: head };
  return { board, job: ran.job, request };
}

test('api.gate.screen-done.ends-in-done: clause 1: a screen job a sprint submission starts through runScreenJob writes its result step and then ends at done with no lease [V16,M1,#12196]', async t => {
  const { board, job, request } = await screenedSubmit(t);
  const view = jobView(board.db, job);
  assert.ok(view.steps.some(step => step.name === 'result'), 'the receipt is stored as the result step');
  assert.equal(view.step, 'done', 'after its result step the job ends at done');
  assert.equal(view.leaseOwner, null, 'the finished screen holds no lease');
  const again = await screenFor(board, request, 'serve:other');
  assert.deepEqual([again.state, again.job], ['stored', job], 'a later driver reads the stored receipt');
  assert.equal(jobView(board.db, job).step, 'done', 'a later read of a stored screen leaves the job done');
});

test('api.gate.screen-done.unseen-when-finished: clause 2: open-job counts and lease sweeps no longer see a finished screen job, and a steady submission makes no screen job [V16,M1,#12196]', async t => {
  const { board } = await screenedSubmit(t);
  const open = board.db.prepare("SELECT count(*) AS n FROM job WHERE job_kind = 'screen' AND job_step <> 'done'").get().n;
  assert.equal(open, 0, 'no screen job counts as open');
  assert.deepEqual(leasedJobs(board.db, { kind: 'screen', now: 0 }), [], 'no screen job reads as leased');
  const later = Date.now() + 24 * 60 * 60 * 1000;
  assert.deepEqual(reclaimLapsed(board.db, { now: later }).filter(row => row.kind === 'screen'), [], 'a lease sweep a day later finds no lapsed screen');
  const steady = pulledSubmit(t, 'steady');
  const runs = servingStarter(t, steady.board);
  assert.equal(steady.post(green(steady.head)).applied.outcome, 'review');
  await settled();
  assert.deepEqual(runs, [], 'a steady submission starts no screen');
  assert.equal(steady.board.db.prepare("SELECT count(*) AS n FROM job WHERE job_kind = 'screen'").get().n, 0, 'a steady board holds no screen job');
});
