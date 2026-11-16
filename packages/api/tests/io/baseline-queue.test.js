/** With runs_store on, the check-baseline offer goes through queueRun: the runs file holds the job and the board one queued run row; off, the board's job rows are as before [B2,P7,#9004]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellSandbox } from '../../../store/tests/fixtures/cell.js';
import { boardRun } from '../../../store/index.js';
import { RUNS_STORE_KEY } from '../../../store/index.js';
import { jobView } from '../../../jobs/index.js';
import { CHECK_BASELINE_KIND } from '../../index.js';
import { offerCheckBaseline } from '../../index.js';
import { queueFor } from '../../index.js';

const MAIN = 'c'.repeat(40);
const EXPECTED = { command: 'npm test', main: MAIN, request: 'req1' };

/** A file board with the runs_store flag set as asked, and its queue (null when off). */
function boardWith(t, flag) {
  const board = cellBoard(t, join(cellSandbox(t).dir, 'board.sqlite'), undefined, { real: true });
  if (flag) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1');
  const queue = queueFor(board, 'coordinator');
  t.after(() => queue?.runs.db.close());
  return { board, queue };
}

test('clause 1: with runs_store on, the baseline offer goes through queueRun and the board holds a queued run row for it [B2,P7]', t => {
  const { board, queue } = boardWith(t, true);
  const job = offerCheckBaseline(board.db, { item: 9004, expected: EXPECTED, command: 'npm test', queue });
  const run = boardRun(board.db, job.id);
  assert.deepEqual([run.run_state, run.run_kind, run.run_item, run.run_candidate], ['queued', CHECK_BASELINE_KIND, 9004, MAIN]);
  assert.equal(jobView(queue.runs.db, job.id).step, 'offered', 'the runs file holds the offered job');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM job').get().n, 0, 'the board writes no job row');
  assert.equal(offerCheckBaseline(board.db, { item: 9004, expected: EXPECTED, command: 'npm test', queue }).id, job.id, 'a retried add reuses the open job');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM run').get().n, 1, 'and queues no second run');
});

test('clause 2: with runs_store off, the baseline offer writes the same board job rows as on main and no run row [B2,P7]', t => {
  const { board, queue } = boardWith(t, false);
  assert.equal(queue, null);
  const job = offerCheckBaseline(board.db, { item: 9004, expected: EXPECTED, command: 'npm test', queue });
  assert.equal(jobView(board.db, job.id).step, 'offered');
  assert.equal(jobView(board.db, job.id).kind, CHECK_BASELINE_KIND);
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM run').get().n, 0);
});
