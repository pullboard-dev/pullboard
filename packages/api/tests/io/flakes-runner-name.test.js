/** With runs_store on, a pulled red's native runs take the runner name from the runs file's receipt step; off, from the board's job row [B2,P7,#9007]. @pullboard-test-input source-cell packages/api packages/store packages/jobs */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { RUNS_STORE_KEY } from '../../../store/index.js';
import { writeStep } from '../../../jobs/index.js';
import { offerJob } from '../../index.js';
import { queueFor } from '../../index.js';
import { recordPulledPairs } from '../../src/io/flakes.js';

const SHA = 'a'.repeat(40);
const FILE = 'web/page.test.js';
const CASE = 'the page renders';

/** A file board with a claimed item, flake ports that capture the recorded gate runs, the flag as asked, and its queue (null when off). */
function boardWith(t, flag) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  const runs = [], folder = repo.root;
  board.enginePorts = { ...board.enginePorts, store: { ...board.enginePorts?.store, recordFlakeObservation() {}, recordGateRun: (_board, { receipt }) => runs.push(receipt) } };
  board.runtimePorts = { ...board.runtimePorts, sourceAdvanceReceipts: { boardReceiptStore: () => join(folder, 'receipts'), receiptBody: run => JSON.stringify(run) } };
  if (flag) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1');
  const queue = queueFor(board, 'coordinator');
  t.after(() => queue?.runs.db.close());
  return { board, queue, runs, item: item.item_id, seat, home: queue ? queue.runs.db : board.db };
}

/** A red gate receipt whose one failing case has a paired rerun, and the submit it answers. */
function pairedRed() {
  const outcomes = [{ file: FILE, name: CASE, passed: false }];
  const pair = { file: FILE, names: [CASE], phase: 'proof', commandSha256: 'b'.repeat(64), paired: { status: 1, ms: 5, tail: 'red', results: { [CASE]: false }, testOutcomes: outcomes }, main: null };
  return { version: 1, status: 1, gate: { source: SHA, green: false, steps: { proof: 7 }, phases: [{ role: 'proof', status: 1, tail: 'red', testOutcomes: outcomes, failures: [{ file: FILE, name: CASE }] }], pairs: [pair] } };
}

test('api.flakes-runner-name.runs-store-receipt-step: clause 1: with runs_store on, recordPulledPairs takes the runner name from the runs-file receipt step [B2,P7]', t => {
  const { board, queue, runs, item, seat, home } = boardWith(t, true);
  offerJob(board.db, { id: 'gate:1', kind: 'gate', item, candidate: SHA, base: SHA, needs: [], now: 1 }, queue);
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM job').get().n, 0, 'the board holds no job rows');
  writeStep(home, 'gate:1', 'receipt', { runner: 'runs-file-runner' }, { seq: 0, now: 2 });
  const done = recordPulledPairs(board, { job: 'gate:1', receipt: pairedRed(), item, candidate: SHA, main: SHA, submit: { tree: SHA, agentId: seat.id, digest: null }, queue });
  assert.equal(done.runs, 2);
  assert.deepEqual(runs.map(run => run.proof.runner), ['runs-file-runner', 'runs-file-runner']);
});

test('api.flakes-runner-name.runs-store-off-job-row: clause 1: with runs_store off, recordPulledPairs still takes the runner name from the board job row [B2,P7]', t => {
  const { board, queue, runs, item, seat } = boardWith(t, false);
  assert.equal(queue, null);
  offerJob(board.db, { id: 'gate:2', kind: 'gate', item, candidate: SHA, base: SHA, needs: [], now: 1 });
  writeStep(board.db, 'gate:2', 'receipt', { runner: 'board-row-runner' }, { seq: 0, now: 2 });
  const done = recordPulledPairs(board, { job: 'gate:2', receipt: pairedRed(), item, candidate: SHA, main: SHA, submit: { tree: SHA, agentId: seat.id, digest: null } });
  assert.equal(done.runs, 2);
  assert.deepEqual(runs.map(run => run.proof.runner), ['board-row-runner', 'board-row-runner']);
});
