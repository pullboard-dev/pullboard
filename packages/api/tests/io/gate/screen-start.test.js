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
  const run = statements(bare.board, () => bare.post(green(bare.head)));
  assert.equal(run.value.applied.outcome, 'review', 'with no starter the sprint submission is recorded as before');
  await settled();
  // The pace is read from the item row the apply already loads: a sprint apply with no starter and a steady apply prepare the same statements.
  assert.equal(run.count, counts.steady, 'no board statement is added');
});
