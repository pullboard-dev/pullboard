/** The reconciler tick ends every row of the design's disagreement table in the action that row names, reading the board read-only, at most every 5 s [B2,P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { LOST_GRACE_MS } from '../../../../../store/index.js';
import { RECONCILE_EVERY_MS } from '../../../../../store/index.js';
import { RUN_APPLIED_EVENT } from '../../../../../store/index.js';
import { RUN_QUEUED_EVENT } from '../../../../../store/index.js';
import { applyRunReceipt } from '../../../../../store/index.js';
import { boardRun } from '../../../../../store/index.js';
import { disagreementAction } from '../../../../../store/index.js';
import { openRunsStore } from '../../../../../store/index.js';
import { pacedReconciler } from '../../../../../store/index.js';
import { queueRun } from '../../../../../store/index.js';
import { reconcileTick } from '../../../../../store/index.js';
import { recordQueuedRun } from '../../../../../store/index.js';
import { runRowsFromEvents } from '../../../../../store/index.js';
import { runsPort } from '../../../../../store/index.js';
import { finishJob } from '../../../../../jobs/index.js';
import { jobView } from '../../../../../jobs/index.js';
import { writeStep } from '../../../../../jobs/index.js';

const MINUTE = 60_000;

/** A board on a clock the test moves, its runs file and port. */
function world(t) {
  const clock = { at: Date.parse('2026-11-15T12:00:00Z'), now() { return new Date(this.at); } };
  const board = cellBoard(t, ':memory:', clock);
  const boardId = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'board_id'").get().meta_value;
  const runs = { db: openRunsStore(':memory:', { boardId }) };
  t.after(() => runs.db.close());
  return { clock, board, runs, port: runsPort(runs) };
}

/** A runner's receipt for one attempt: the receipt step, then the job done. */
function post(runs, job, attempt, now) {
  writeStep(runs.db, job, 'receipt', { runner: 'r1', attempt, receipt: { status: 'green', outcome: 'green' } }, { seq: attempt, now });
  finishJob(runs.db, job, 'r1', { now });
}

const appliedMark = (runs, job) => runs.db.prepare('SELECT job_applied FROM job WHERE job_id = ?').get(job).job_applied;
const boardWrites = board => board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n;

test('clause 2: a seeded board and runs pair holding every row of the disagreement table ends in the action that row names [B2,P7]', t => {
  const { clock, board, runs, port } = world(t);
  const at = () => clock.at;
  // Rows 1 and 2: no board run, a pending job young and old.
  port.intend({ id: 'gate:old', kind: 'gate', now: at() - LOST_GRACE_MS - MINUTE });
  // Row 3: the run committed, the job was never offered.
  port.intend({ id: 'gate:unoffered', kind: 'gate', now: at() });
  recordQueuedRun(board, { by: 'coordinator', id: 'gate:unoffered', kind: 'gate' });
  // Row 4: a queued run whose job the runs file lost, past the grace.
  recordQueuedRun(board, { by: 'coordinator', id: 'gate:lost', kind: 'gate' });
  clock.at += LOST_GRACE_MS + MINUTE;
  port.intend({ id: 'gate:young', kind: 'gate', now: at() - MINUTE });
  // Row 5: a receipt waiting on a queued run.
  queueRun(board, port, { by: 'coordinator', id: 'gate:receipt', kind: 'gate' });
  post(runs, 'gate:receipt', 1, at());
  // Row 6: the board applied the receipt, the runs file never marked it.
  queueRun(board, port, { by: 'coordinator', id: 'gate:unmarked', kind: 'gate' });
  post(runs, 'gate:unmarked', 1, at());
  applyRunReceipt(board, { by: 'coordinator', job: 'gate:unmarked', attempt: 1, outcome: 'green' });
  // Row 7: a withdrawn run whose job is still live.
  queueRun(board, port, { by: 'coordinator', id: 'gate:withdrawn', kind: 'gate' });
  board.db.prepare("UPDATE run SET run_state = 'withdrawn' WHERE run_job = 'gate:withdrawn'").run();
  // Row 8: the board is on attempt 2; the receipt in the runs file is attempt 1.
  queueRun(board, port, { by: 'coordinator', id: 'gate:stale', kind: 'gate' });
  applyRunReceipt(board, { by: 'coordinator', job: 'gate:stale', attempt: 2, outcome: 'red' });
  post(runs, 'gate:stale', 1, at());
  // Row 9: a job claimed past the cap.
  queueRun(board, port, { by: 'coordinator', id: 'gate:runaway', kind: 'gate' });
  runs.db.prepare("UPDATE job SET job_attempt = 12 WHERE job_id = 'gate:runaway'").run();
  const staleBefore = { ...boardRun(board.db, 'gate:stale') };

  const done = reconcileTick(board, runs, port, { by: 'coordinator' });
  assert.deepEqual(Object.fromEntries(done.map(row => [row.job, row.action])), {
    'gate:old': 'abandon', 'gate:unoffered': 'confirm', 'gate:lost': 'lost', 'gate:receipt': 'apply',
    'gate:unmarked': 'mark-applied', 'gate:withdrawn': 'cancel', 'gate:stale': 'stale', 'gate:runaway': 'runaway',
  }, 'the young pending job waits and is not listed');

  assert.equal(jobView(runs.db, 'gate:young').step, 'pending', 'wait changes nothing');
  assert.equal(jobView(runs.db, 'gate:old').step, 'cancelled', 'abandoned: nothing ran');
  assert.equal(jobView(runs.db, 'gate:unoffered').step, 'offered');
  assert.deepEqual([boardRun(board.db, 'gate:lost').run_state, boardRun(board.db, 'gate:lost').run_outcome], ['lost', 'RUN_LOST']);
  assert.deepEqual([boardRun(board.db, 'gate:receipt').run_state, boardRun(board.db, 'gate:receipt').run_outcome], ['done', 'green']);
  assert.ok(appliedMark(runs, 'gate:receipt') > 0);
  assert.ok(appliedMark(runs, 'gate:unmarked') > 0);
  assert.equal(jobView(runs.db, 'gate:withdrawn').step, 'cancelled');
  assert.deepEqual(boardRun(board.db, 'gate:stale'), staleBefore, 'a stale receipt is never applied');
  assert.ok(appliedMark(runs, 'gate:stale') > 0, 'but it leaves the inbox');
  assert.deepEqual([boardRun(board.db, 'gate:runaway').run_state, boardRun(board.db, 'gate:runaway').run_outcome], ['runaway', 'RUN_RUNAWAY']);
  assert.equal(jobView(runs.db, 'gate:runaway').step, 'cancelled');

  assert.deepEqual(reconcileTick(board, runs, port, { by: 'coordinator' }), [], 'a second tick finds nothing to settle');
  const events = board.db.prepare('SELECT event_at, item_id, event_kind, event_detail FROM event WHERE event_kind IN (?, ?) ORDER BY event_id').all(RUN_QUEUED_EVENT, RUN_APPLIED_EVENT);
  const table = board.db.prepare("SELECT * FROM run WHERE run_state != 'withdrawn' ORDER BY run_job").all().map(row => ({ ...row }));
  assert.deepEqual(runRowsFromEvents(events).filter(row => row.run_job !== 'gate:withdrawn').map(row => [row.run_job, row.run_state, row.run_outcome]), table.map(row => [row.run_job, row.run_state, row.run_outcome]),
    'the moves the tick made replay from the event log');
});

test('clause 2: a queued run whose job is gone waits out the grace before the board marks it lost [B2,P7]', t => {
  const { clock, board, runs, port } = world(t);
  recordQueuedRun(board, { by: 'coordinator', id: 'gate:lost', kind: 'gate' });
  clock.at += LOST_GRACE_MS - MINUTE;
  assert.deepEqual(reconcileTick(board, runs, port), []);
  assert.equal(boardRun(board.db, 'gate:lost').run_state, 'queued');
  clock.at += 2 * MINUTE;
  assert.deepEqual(reconcileTick(board, runs, port).map(row => row.action), ['lost']);
});

test('clause 1: a tick that changes nothing writes nothing to the board, and the table is a pure function of what it reads [B2,P7]', t => {
  const { board, runs, port } = world(t);
  queueRun(board, port, { by: 'coordinator', id: 'gate:ok', kind: 'gate' });
  port.intend({ id: 'gate:young', kind: 'gate', now: board.clock.now().getTime() });
  const before = boardWrites(board), run = { ...boardRun(board.db, 'gate:ok') };
  assert.deepEqual(reconcileTick(board, runs, port), []);
  assert.equal(boardWrites(board), before);
  assert.deepEqual(boardRun(board.db, 'gate:ok'), run);
  assert.equal(disagreementAction({ run: null, job: null, applied: false, receipt: null, now: 0 }), 'settled');
});

test('clause 1: the paced tick runs at most every 5 s, and on its first call [B2,P7]', () => {
  let now = 1_000, ticks = 0;
  const paced = pacedReconciler(() => ++ticks, { clock: () => now });
  assert.equal(paced(), 1);
  now += RECONCILE_EVERY_MS - 1;
  assert.equal(paced(), null);
  now += 1;
  assert.equal(paced(), 2);
  assert.equal(RECONCILE_EVERY_MS, 5000);
});
