/** @pullboard-test-input source-cell store */
// fixture-subject: the store claim writer with the live claim table deciding, for a coordinator seat and a lane seat claiming from a lane worktree
/** The live claim table reads the lane the claim runs from for the coordinator seat only, as the writer does; every other seat keeps its registered lane [C7,#10883]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../fixtures/cell.js';
import { cellClaim } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellProject } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';

/** A real board whose claims the live claim table decides, with one open web item. */
function setup(t) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  board.movesLive = { ...(board.movesLive ?? {}), claim: true };
  const item = cellItem(board, { lane: 'web', title: 'Lane fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' });
  return { board, root: project.repo, id: item.item_id };
}

test('store.io-board-claim-table.coordinator-lane-from-claim: clause 1: a seat registered in the coordinator lane claiming a web item from a web worktree is not refused WRONG_LANE by the live claim table [C7,#10883]', t => {
  const { board, root, id } = setup(t);
  const seat = cellSeat(board, { lane: 'coordinator', path: root });
  let code = null;
  try { cellClaim(board, id, seat, { root, lane: 'web' }); } catch (error) { code = error.code ?? error.name; }
  assert.notEqual(code, 'WRONG_LANE', 'the table reads the lane the coordinator claims from, as the writer does');
  assert.equal(code, null, 'the claim is written');
  assert.equal(board.db.prepare('SELECT item_status, item_owner FROM item WHERE item_id=?').get(id).item_owner, seat.id);
});

test('store.io-board-claim-table.seat-lane-unchanged: clause 2: a seat registered in the api lane claiming a web item with a web lane option is still refused WRONG_LANE by the live claim table [C7,#10883]', t => {
  const { board, root, id } = setup(t);
  const seat = cellSeat(board, { lane: 'api', path: root });
  assert.throws(() => cellClaim(board, id, seat, { root, lane: 'web' }), { code: 'WRONG_LANE' });
  assert.equal(board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(id).item_status, 'open', 'nothing is written');
});
