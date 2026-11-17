/** A reject on a landed mid item files its follow-up and records the verdict instead of refusing NO_BRIEF [C7,#8835]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { cellItem } from '../../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../../store/tests/fixtures/cell.js';

const BRIEF = 'Fix the thing.\n\nFiles:\n- web/result.txt\n\nTest: web/result.test.js asserts the result.';
const COMMIT = 'a'.repeat(40);

/** A mid item landed by a forced merge, and a reviewer seat to reject it. */
function landed(t, item) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  store.board_ensureCoordinator(board, project.repo);
  const reviewer = cellSeat(board, { lane: 'web', path: `${project.dir}/reviewer` }).id;
  const row = cellItem(board, { lane: 'web', title: 'Landed mid', criterion: '1. It works [test]', specIds: ['G1'], route: 'mid', ...item });
  store.merged(board, row.item_id, { agentId: 'coordinator', commit: COMMIT, forced: 'landed by hand', waiveProof: 'test fixture' });
  return { board, id: row.item_id, reviewer };
}

/** Reject the landed item as the reviewer. */
const reject = ({ board, id, reviewer }) => store.verify(board, id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE', note: 'the result is wrong',
  head: COMMIT, digest: '', policy: 'any', landed: true });

test('board.verify-landed-followup.landed-mid-reject-records-the-verdict: clause 1: a landed mid reject records the verdict and files a follow-up carrying the Files:, Test: and check [C7,#8835]', t => {
  const f = landed(t, { brief: BRIEF, check: 'node --test web/result.test.js' });
  const result = reject(f);
  const followUp = store.getItem(f.board, result.followUp);
  assert.equal(store.getItem(f.board, f.id).item_verdict, 'REJECT');
  assert.equal(followUp.item_route, 'mid');
  assert.equal(followUp.item_check, 'node --test web/result.test.js');
  assert.match(followUp.item_brief, /Files:\n- web\/result\.txt/);
  assert.match(followUp.item_brief, /Test: web\/result\.test\.js/);
});

test('board.verify-landed-followup.landed-mid-reject-with-brief-still: clause 2: a landed mid reject with no brief still records the verdict and files a strong follow-up [C7,#8835]', t => {
  const f = landed(t, { route: 'strong', brief: '' });
  f.board.db.prepare("UPDATE item SET item_route = 'mid' WHERE item_id = ?").run(f.id);
  assert.equal(store.getItem(f.board, f.id).item_route, 'mid', 'the landed item is routed mid with no brief and no check');
  const result = reject(f);
  assert.equal(store.getItem(f.board, f.id).item_verdict, 'REJECT');
  assert.equal(store.getItem(f.board, result.followUp).item_route, 'strong');
});
