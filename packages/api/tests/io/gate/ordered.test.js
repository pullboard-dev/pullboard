/** On a relay-linked board a pulled gate's receipt hands its engine moves to the relay; a local board applies them at once [C7,H3,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { cellClaim } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import * as store from '../../../../store/index.js';
import { testResults } from '../../../../store/index.js';
import { boardJobQueueCall } from '../../../index.js';
import { claimJob } from '../../../index.js';
import { offerJob } from '../../../index.js';

/** A claimed item with a gate job offered for its head, as a pulled submit leaves it; post(receipt, options) answers as the jobs route. */
function pulledSubmit(t) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const held = store.getItem(board, item.item_id);
  const head = repo.commit;
  const tree = String(runFixtureGit(['rev-parse', `${head}^{tree}`], { cwd: repo.root }).stdout).trim();
  const job = `gate:${item.item_id}:ordered`;
  offerJob(board.db, { id: job, kind: 'gate', needs: [], item: item.item_id, candidate: head, base: head, now: 1,
    request: { run: ['true'], input: { data: {} }, submit: { agentId: seat.id, digest: held.item_frozen_digest, tree, files: [] } } });
  const lease = claimJob(board.db, { runner: 'r-ordered', capabilities: [], now: 2 });
  const post = (receipt, options = {}) => boardJobQueueCall(board, { action: 'receipt', job, runner: 'r-ordered', token: lease.token, receipt }, { mode: 'pull', now: 3, ...options });
  return { board, seat, id: item.item_id, head, job, post };
}

const LEDGER = { contexts: ['e'.repeat(64)], files: [['web/page.test.js', '1'.repeat(64), 0, 'pass']], omitted: 0 };
const green = head => ({ version: 1, status: 0, gate: { source: head, green: true, phases: [{ role: 'proof', status: 0, ledger: LEDGER }] } });
const red = head => ({ version: 1, status: 1, gate: { source: head, green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: 'web/page.test.js', name: 'the page renders' }] }] } });

test('api.gate-ordered.linked-board-green-pulled-gate: clause 1: on a linked board a green pulled gate hands its submit to the relay, and the relay\'s order submits the item [C7,H16]', t => {
  const { board, seat, id, head, job, post } = pulledSubmit(t);
  const ordered = [];
  const posted = post(green(head), { ordered });
  assert.equal(posted.recorded, true, 'the runner\'s receipt is recorded on the job');
  assert.equal(posted.applied.outcome, 'review', `the apply judged the gate as on a local board: ${JSON.stringify(posted.applied)} ${ordered.map(move => move.args[1]?.text).join(' | ').replace(/\n/gu, ' / ')}`);
  assert.deepEqual(ordered.map(move => move.operation), ['submit', 'appendFact'], 'the submit and its gate note are the moves the relay orders');
  assert.equal(ordered[0].args[0], id);
  assert.equal(ordered[0].args[1].agentId, seat.id);
  assert.equal(ordered[0].args[1].commit, head);
  assert.match(ordered[1].args[1].text, new RegExp(`^Gate job ${job} green at ${head.slice(0, 12)}`, 'u'));
  const before = store.getItem(board, id);
  assert.equal(before.item_status, 'claimed', 'this replica waits for the relay\'s order like every other replica');
  assert.ok(!store.itemThread(board, id).some(fact => fact.text?.startsWith(`Gate job ${job} green`)), 'no gate note is left behind on this replica alone');
  assert.equal(board.db.prepare("SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ? AND job_step_name = 'receipt'").get(job).n, 1, 'the receipt row is kept');
  assert.deepEqual(testResults(board.db, { inputKey: '1'.repeat(64) }).map(row => row.status), ['pass'], 'the proof-ledger row the receipt wrote, no engine move, is kept');

  // The relay's order applies each move through the engine's store writer, on this replica and every other alike.
  for (const { operation, args } of ordered) store[operation](board, ...structuredClone(args));
  const after = store.getItem(board, id);
  assert.equal(after.item_status, 'submitted');
  assert.equal(after.item_commit, head);
});

test('api.gate-ordered.linked-board-red-pulled-gate: clause 1: on a linked board a red pulled gate hands its failing parts to the relay and leaves the item claimed [C7,H16]', t => {
  const { board, id, head, job, post } = pulledSubmit(t);
  const ordered = [];
  const posted = post(red(head), { ordered });
  assert.equal(posted.applied.outcome, 'red');
  assert.ok(!ordered.some(move => move.operation === 'submit'), 'a red gate submits nothing');
  const fact = ordered.find(move => move.operation === 'appendFact');
  assert.match(fact.args[1].text, new RegExp(`^Gate job ${job} red at ${head.slice(0, 12)}`, 'u'));
  assert.equal(store.getItem(board, id).item_status, 'claimed');
  assert.ok(!store.itemThread(board, id).some(row => row.text?.startsWith(`Gate job ${job} red`)), 'the red note waits for the relay\'s order');
});

test('api.gate-ordered.local-board-applies-green-pulled: clause 1: a local board applies a green pulled gate at once, as before [C7]', t => {
  const { board, id, head, job, post } = pulledSubmit(t);
  const posted = post(green(head));
  assert.equal(posted.applied.outcome, 'review', JSON.stringify(posted.applied));
  const item = store.getItem(board, id);
  assert.equal(item.item_status, 'submitted');
  assert.equal(item.item_commit, head);
  assert.ok(store.itemThread(board, id).some(fact => fact.text?.startsWith(`Gate job ${job} green`)));
});
