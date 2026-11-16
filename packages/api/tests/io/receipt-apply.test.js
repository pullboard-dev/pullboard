/** With runs_store on, the serve applies each posted receipt right after it arrives and leaves none unapplied; off, nothing changes [B2,P7,#9546]. @pullboard-test-input source-cell packages/api packages/store packages/jobs */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { boardRun } from '../../../store/index.js';
import { RUN_APPLIED_EVENT } from '../../../store/index.js';
import { RUNS_STORE_KEY } from '../../../store/index.js';
import { boardJobQueueCall } from '../../index.js';
import { claimJob } from '../../index.js';
import { offerJob } from '../../index.js';
import { queueFor } from '../../index.js';

const MAIN = 'a'.repeat(40);

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
  return { board, queue, home: queue ? queue.runs.db : board.db };
}

/** Offer a no-effect job where it lives, claim it there as a runner, and post its receipt through the serve's queue call. */
function postThroughServe(board, queue, home, id) {
  offerJob(board.db, { id, kind: 'noop', needs: [], candidate: MAIN, base: MAIN, now: 11 }, queue);
  const held = claimJob(home, { runner: 'r1', capabilities: [], now: 13 });
  assert.equal(held.job, id);
  return boardJobQueueCall(board, { action: 'receipt', job: id, runner: 'r1', token: held.token, receipt: { version: 1, status: 0 } }, { mode: 'pull', now: 14 });
}

test('clause 1: with runs_store on, a receipt posted to the serve is applied at once and no unapplied receipt is left [B2,P7]', t => {
  const { board, queue, home } = boardWith(t, true);
  const answer = postThroughServe(board, queue, home, 'note:1');
  assert.equal(answer.recorded, true);
  assert.equal(boardRun(board.db, 'note:1').run_state, 'done', 'the board run row took the receipt\'s outcome');
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM event WHERE event_kind = ?').get(RUN_APPLIED_EVENT).n, 1, 'the attempt is applied once');
  assert.deepEqual(queue.port.receiptsSince(0, { limit: 10 }), [], 'the receipt is acked, so the inbox holds nothing unapplied');
});

test('clause 1: with runs_store off, the serve posts to the board\'s job rows as on main and writes no run row [B2,P7]', t => {
  const { board, queue, home } = boardWith(t, false);
  assert.equal(queue, null);
  const answer = postThroughServe(board, queue, home, 'note:2');
  assert.equal(answer.recorded, true);
  assert.deepEqual(answer.applied, { applied: false, outcome: 'recorded' });
  assert.equal(board.db.prepare('SELECT COUNT(*) AS n FROM run').get().n, 0);
});
