/** The live claim table and the claim writer give one answer for a seat that never joined: both refuse it, and a joined seat is allowed [C7,#10952]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';

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
