/** A seat's declared review limits decide which reviews next --verify offers it [O2,V15]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { fixtureBoard } from '../../../../packages/board/tests/fixtures/board.js';
import {
  cellItem,
  cellSeat,
} from '../../../../packages/store/tests/fixtures/cell.js';

/** A board whose builder declared the Fixture-Builder family, with one item it built waiting for review. */
function queue(t) {
  const board = fixtureBoard(t);
  cellSeat(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = cellSeat(board, { lane: 'core', path: '/builder', family: 'Fixture-Builder' });
  const item = cellItem(board, { lane: 'core', title: 'a same-family review waits' });
  store.claim(board, item.item_id, { agentId: builder.id, lane: 'core', leaseMs: 3_600_000, freeze: row => ({ text: row.item_title, digest: `digest:${row.item_title}` }) });
  submitFixture(board, item.item_id, { agentId: builder.id, commit: '1'.repeat(40), tree: '1'.repeat(40) });
  return { board, id: item.item_id };
}

test('clause 1: a seat declaring not-same-family is never offered same-family reviews by next --verify [O2,V15]', t => {
  const { board, id } = queue(t);
  const limited = cellSeat(board, { lane: 'review', path: '/limited', family: 'Fixture-Builder', reviewLimits: ['not-same-family'] });
  assert.equal(store.nextFor(board, { agentId: limited.id, lane: 'review', verify: true }).item, null, 'the limited seat is offered nothing');
  assert.throws(() => store.reserveReview(board, id, { agentId: limited.id, leaseMs: 3_600_000, policy: 'any' }),
    error => error.code === 'SAME_FAMILY' || error.code === 'O2_FAMILY_MATCH', 'it cannot reserve the review either');
  const other = cellSeat(board, { lane: 'review', path: '/other', family: 'Fixture-Other', reviewLimits: ['not-same-family'] });
  assert.equal(store.nextFor(board, { agentId: other.id, lane: 'review', verify: true }).item.item_id, id, 'the limit only refuses its own family');
});

test('clause 2: a seat with no declared limits is offered reviews as before [O2,V15]', t => {
  const { board, id } = queue(t);
  const open = cellSeat(board, { lane: 'review', path: '/open', family: 'Fixture-Builder' });
  assert.equal(store.nextFor(board, { agentId: open.id, lane: 'review', verify: true }).item.item_id, id);
});
