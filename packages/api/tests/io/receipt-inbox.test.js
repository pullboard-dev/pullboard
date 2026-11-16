/** With runs_store on, a receipt in the runs inbox applies once per attempt and waiting gates settle from board run summaries; off, both read the board's job rows [B2,P7,#9006]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { boardRun } from '../../../store/index.js';
import { applyRunReceipt } from '../../../store/index.js';
import { queueRun } from '../../../store/index.js';
import { RUN_APPLIED_EVENT } from '../../../store/index.js';
import { RUNS_STORE_KEY } from '../../../store/index.js';
import { writeStep } from '../../../jobs/index.js';
import { applyInbox } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';
import { postReceipt } from '../../index.js';
import { queueFor } from '../../index.js';
import { settleWaitingGates } from '../../src/io/gate.js';

const FILE = 'web/page.test.js';
const CASE = 'the page renders';
const MAIN = 'a'.repeat(40);
const MAIN_TEST_JOB = 'main-test';
const RED = { version: 1, status: 1, gate: { source: MAIN, green: false, phases: [{ role: 'proof', status: 1, failures: [{ file: FILE, name: CASE }] }] } };

/** A file board with a claimed item, the runs_store flag as asked, and its queue (null when off). */
function boardWith(t, flag) {
  const repo = cellRepo(t, { real: true });
  const board = cellBoard(t, repo.boardFile, undefined, { real: true, gitRoot: repo.root });
  board.gitRoot = repo.root;
  const seat = cellSeat(board, { lane: 'web', path: `${repo.root}/seat` });
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, seat, { root: repo.root });
  if (flag) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1');
  const queue = queueFor(board, 'coordinator');
  t.after(() => queue?.runs.db.close());
  return { board, queue, item: item.item_id, home: queue ? queue.runs.db : board.db };
}

/** Offer a job to where it lives (queued when the flag is on), claim it there, and post its receipt. */
let tick = 0;
function posted(board, queue, home, { id, kind, item = null, receipt, keyed = null }) {
  const base = (tick += 10), runner = `r${base}`;
  offerJob(board.db, { id, kind, item, candidate: MAIN, base: MAIN, needs: [], now: base + 1 }, queue);
  const held = claimJob(home, { runner, capabilities: [], now: base + 3 });
  assert.equal(held.job, id);
  if (keyed) writeStep(home, id, 'receipt', keyed, { seq: 0, now: base + 2 });
  return postReceipt(home, { job: id, runner, token: held.token, receipt, now: base + 4 });
}

/** The cases the lookup was asked about while settling, for a main-test receipt recorded on FILE. */
function settledCases(board, queue, main) {
  const seen = [];
  settleWaitingGates(board, main, { compareWithMain: ({ cases }) => { seen.push(cases.map(row => row.name)); return { classes: [] }; }, queue });
  return seen;
}

test('clause 1: with runs_store on, applyInbox takes the receipt from the runs inbox and applies each attempt once [B2,P7]', t => {
  const { board, queue, home } = boardWith(t, true);
  const post = posted(board, queue, home, { id: 'note:1', kind: 'noop', receipt: { version: 1, status: 0 } });
  assert.equal(post.recorded, true);
  const first = applyInbox(board, queue);
  assert.deepEqual(first.map(row => [row.job, row.attempt, row.outcome]), [['note:1', post.attempt, 'recorded']], 'the receipt applies through the receipt applier, by its run kind');
  assert.equal(boardRun(board.db, 'note:1').run_state, 'done');
  assert.deepEqual(applyInbox(board, queue), [], 'an acked receipt leaves the inbox');
  home.prepare('UPDATE job SET job_applied = NULL').run();
  assert.deepEqual(applyInbox(board, queue).map(row => row.outcome), ['already-applied'], 'a crash before the ack repeats as a no-op');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM event WHERE event_kind = ?').get(RUN_APPLIED_EVENT).n, 1, 'the attempt is applied once');
});

test('clause 2: with runs_store on, settleWaitingGates reads the earlier gates from board run summaries [B2,P7]', t => {
  const { board, queue, item } = boardWith(t, true);
  queueRun(board, queue.port, { by: 'coordinator', id: 'gate:G', kind: 'gate', item, candidate: MAIN, base: MAIN });
  queueRun(board, queue.port, { by: 'coordinator', id: 'main:M', kind: MAIN_TEST_JOB, base: MAIN });
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM job').get().n, 0, 'the board holds no job rows');
  applyRunReceipt(board, { by: 'coordinator', job: 'gate:G', attempt: 1, outcome: 'red', summary: RED });
  applyRunReceipt(board, { by: 'coordinator', job: 'main:M', attempt: 1, outcome: 'green', summary: { file: FILE } });
  assert.deepEqual(settledCases(board, queue, 'main:M'), [[CASE]], 'the red gate\'s failing case came from its run summary');
});

test('clause 3: with runs_store off, both read the board\'s job rows as on main [B2,P7]', t => {
  const { board, queue, item, home } = boardWith(t, false);
  assert.equal(queue, null);
  posted(board, null, home, { id: 'gate:G', kind: 'gate', item, receipt: RED });
  posted(board, null, home, { id: 'main:M', kind: MAIN_TEST_JOB, keyed: { file: FILE }, receipt: { commit: MAIN, tail: '' } });
  assert.deepEqual(settledCases(board, null, 'main:M'), [[CASE]], 'the failing case came from the posted receipt');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM run').get().n, 0);
});
