/** The receipt inbox applies each job's receipt to the board once, by job and attempt, and run rows replay from events [B2,R2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../fixtures/cell.js';
import { RUN_APPLIED_EVENT } from '../../../index.js';
import { RUN_QUEUED_EVENT } from '../../../index.js';
import { applyReceipts } from '../../../index.js';
import { applyRunReceipt } from '../../../index.js';
import { boardRun } from '../../../index.js';
import { openRunsStore } from '../../../index.js';
import { queueRun } from '../../../index.js';
import { runRowsFromEvents } from '../../../index.js';
import { runsPort } from '../../../index.js';
import { finishJob } from '../../../../jobs/index.js';
import { writeStep } from '../../../../jobs/index.js';

const clock = { now: () => new Date() };
const JOB = 'gate:3:abc:t1';

/** A board, its runs file and port, with one queued gate job. */
function queued(t) {
  const board = cellBoard(t, ':memory:', clock);
  const boardId = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = 'board_id'").get().meta_value;
  const runs = { db: openRunsStore(':memory:', { boardId }) };
  t.after(() => { try { runs.db.close(); } catch { /* The replay test closed it itself. */ } });
  const port = runsPort(runs);
  queueRun(board, port, { by: 'coordinator', id: JOB, kind: 'gate', candidate: 'abc' });
  return { board, runs, port };
}

/** Post a runner's receipt for one attempt the way the queue does: the receipt step, then the job done. */
function post(runs, job, attempt, receipt) {
  writeStep(runs.db, job, 'receipt', { runner: 'r1', attempt, receipt }, { seq: attempt });
  finishJob(runs.db, job, 'r1');
}

/** The applied mark of a job in the runs file. */
const appliedMark = (runs, job) => runs.db.prepare('SELECT job_applied FROM job WHERE job_id = ?').get(job).job_applied;

/** How many events of a kind the board logged for the job. */
const eventsFor = (board, kind, job) => board.db.prepare('SELECT event_detail FROM event WHERE event_kind = ?').all(kind)
  .filter(row => JSON.parse(row.event_detail).job === job).length;

test('a posted receipt waits unapplied; the drain applies it in one board move, then acks it in the runs file [B2,R2]', t => {
  const { board, runs, port } = queued(t);
  post(runs, JOB, 1, { status: 'green', outcome: 'green', failing: [], log: 'x'.repeat(500) });
  assert.equal(appliedMark(runs, JOB), null, 'posting leaves the inbox mark empty');
  assert.deepEqual(port.receiptsSince(0).map(row => [row.job, row.attempt]), [[JOB, 1]]);
  assert.deepEqual(applyReceipts(board, runs, port, { by: 'coordinator' }), [{ job: JOB, attempt: 1, applied: true }]);
  const run = boardRun(board.db, JOB);
  assert.deepEqual([run.run_state, run.run_attempt, run.run_outcome], ['done', 1, 'green']);
  const summary = JSON.parse(run.run_summary);
  assert.equal(summary.log.bytes, 500, 'a long string is kept as its hash and size');
  assert.equal(typeof summary.log.sha256, 'string');
  assert.equal(eventsFor(board, RUN_APPLIED_EVENT, JOB), 1);
  assert.ok(appliedMark(runs, JOB) > 0, 'the ack marks the job applied');
  assert.deepEqual(port.receiptsSince(0), [], 'an acked receipt leaves the inbox');
});

test('applying the same attempt twice, or an older one, changes no board row; a crash before the ack is settled by the next drain [B2,R2]', t => {
  const { board, runs, port } = queued(t);
  post(runs, JOB, 2, { status: 'red', outcome: 'red', failing: ['a.test.js'] });
  assert.equal(applyRunReceipt(board, { by: 'coordinator', job: JOB, attempt: 2, outcome: 'red', summary: { failing: ['a.test.js'] } }).applied, true);
  const after = boardRun(board.db, JOB);
  assert.equal(applyRunReceipt(board, { by: 'coordinator', job: JOB, attempt: 2, outcome: 'green' }).applied, false, 'the same attempt again');
  assert.equal(applyRunReceipt(board, { by: 'coordinator', job: JOB, attempt: 1, outcome: 'green' }).applied, false, 'an older attempt');
  assert.deepEqual(boardRun(board.db, JOB), after, 'the run row is unchanged');
  assert.equal(eventsFor(board, RUN_APPLIED_EVENT, JOB), 1);
  assert.equal(appliedMark(runs, JOB), null, 'the move committed but the ack never ran, as after a crash');
  assert.deepEqual(applyReceipts(board, runs, port, { by: 'coordinator' }), [{ job: JOB, attempt: 2, applied: false }], 'the drain re-applies as a no-op');
  assert.ok(appliedMark(runs, JOB) > 0, 'and then acks it');
  assert.deepEqual(boardRun(board.db, JOB), after);
});

test('replaying the board events rebuilds the run rows, summaries included, with no runs file present [B2,R2]', t => {
  const { board, runs, port } = queued(t);
  queueRun(board, port, { by: 'coordinator', id: 'land:9:k', kind: 'land' });
  post(runs, JOB, 1, { status: 'green', outcome: 'green', cases: Array.from({ length: 30 }, (_, n) => `case ${n}`) });
  applyReceipts(board, runs, port, { by: 'coordinator' });
  runs.db.close();
  const events = board.db.prepare('SELECT event_at, item_id, event_kind, event_detail FROM event WHERE event_kind IN (?, ?) ORDER BY event_id')
    .all(RUN_QUEUED_EVENT, RUN_APPLIED_EVENT);
  const table = board.db.prepare('SELECT * FROM run ORDER BY run_job').all().map(row => ({ ...row }));
  assert.equal(table.length, 2);
  assert.deepEqual(runRowsFromEvents(events), table, 'the run table is a projection of the event log');
  assert.equal(JSON.parse(table.find(row => row.run_job === JOB).run_summary).cases.bytes > 0, true, 'a long list is kept as its hash and size');
});
