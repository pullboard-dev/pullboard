/** The pull submit's gate offer goes through queueRun while runs_store is on, and is unchanged while it is off [B2,P7,#7418]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellBoard } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { cellSandbox } from '../../../../../../packages/store/tests/fixtures/cell.js';
import { boardRun } from '../../../../../../packages/store/index.js';
import { RUNS_STORE_KEY } from '../../../../../../packages/store/index.js';
import { jobView } from '../../../../../../packages/jobs/index.js';
import { queueFor } from '../../../../../../packages/api/index.js';
import { offerGateJob } from '../../../../src/io/submit/pull.js';

const MAIN = 'a'.repeat(40);
const SOURCE = 'b'.repeat(40);

/** A file board with the runs_store flag set as asked, and the one gate offer the pulled submit makes on it. */
function offerOne(t, flag) {
  const board = cellBoard(t, join(cellSandbox(t).dir, 'board.sqlite'), undefined, { real: true });
  if (flag) board.db.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run(RUNS_STORE_KEY, '1');
  const queue = queueFor(board, 'core-1');
  t.after(() => queue?.runs.db.close());
  const job = offerGateJob(board.db, { item: 7418, main: MAIN, source: SOURCE, request: {}, ...(queue ? { queue } : {}) });
  return { board, queue, job };
}

test('clause 1: with runs_store on, the pull submit offers its gate job through queueRun and the board holds a queued run row [B2,P7]', t => {
  const { board, queue, job } = offerOne(t, true);
  assert.ok(queue, 'the flag is on, so there is a queue');
  assert.equal(job.kind, 'gate');
  assert.equal(boardRun(board.db, job.id).run_state, 'queued', 'the board holds the run');
  assert.equal(jobView(queue.runs.db, job.id).step, 'offered', 'the runs file holds the offered job');
});

test('clause 2: with runs_store off, the pull gate offer writes the same rows as today [B2,P7]', t => {
  const { board, queue, job } = offerOne(t, false);
  assert.equal(queue, null, 'the flag is off, so there is no queue');
  assert.equal(job.step, 'offered');
  assert.equal(jobView(board.db, job.id).step, 'offered', 'the board itself holds the offered job');
  assert.equal(boardRun(board.db, job.id), undefined, 'no run row is written');
});
