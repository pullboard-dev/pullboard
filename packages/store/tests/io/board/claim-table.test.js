/** @pullboard-test-input source-cell store */
// fixture-subject: the store claim writer with the live claim table deciding, for a coordinator seat and a lane seat claiming from a lane worktree
/** The live claim table and the claim writer give one answer: the table reads the lane the claim runs from for the coordinator seat only, every other seat keeps its registered lane [C7,#10883], and both refuse a seat that never joined [C7,#10952]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
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

const freeze = () => ({ text: '{}', digest: 'claim-table-fixture' });

test('store.io-board-claim-table.unjoined-seat-refused-joined-allowed: clause 2: with moves.live.claim on, the claim refuses NOT_JOINED for a seat that never joined and writes nothing, and the same claim by a joined seat is written [C7]', t => {
  const board = cellBoard(t, ':memory:');
  board.movesLive = { claim: true };
  cellSeat(board, { lane: 'coordinator', path: '/seat/coordinator' });
  const joined = cellSeat(board, { lane: 'core', path: '/seat/builder' });
  const { item_id: id } = cellItem(board, { lane: 'core', title: 'Unjoined claim', criterion: '1. the claim is recorded [test].', route: 'strong', check: 'true' });
  const claim = agentId => store.claim(board, id, { agentId, lane: 'core', leaseMs: 60 * 60_000, freeze });
  assert.throws(() => claim('core-99'), error => error.code === 'NOT_JOINED', 'a seat with no agent row is refused');
  assert.equal(board.db.prepare("SELECT COUNT(*) n FROM event WHERE item_id=? AND event_kind='claim'").get(id).n, 0, 'the refusal wrote no claim');
  claim(joined.id);
  assert.equal(board.db.prepare('SELECT item_owner owner FROM item WHERE item_id=?').get(id).owner, joined.id, 'the joined seat holds the item');
});
