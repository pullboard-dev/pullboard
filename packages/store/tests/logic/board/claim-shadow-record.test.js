/** With moves.shadow on, the claim writer records each claim table shadow compare on the board; off, it records nothing [C7,#8376]. */
/** @pullboard-test-input packages/store/src/io/board/shadow-record.js packages/store/src/io/board/claim.js */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';
import { cellSeat } from '../../fixtures/cell.js';

const AT = Date.parse('2026-11-15T12:00:00.000Z');

/**
 * A board with one open item and one seat to claim it. `shadow` is the board's stand-in for the moves.shadow machine
 * setting; left undefined, the writer reads the test runner's own machine settings, which leave it at its default.
 */
function claimable(t, shadow) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  if (shadow !== undefined) board.movesShadow = shadow;
  cellSeat(board, { lane: 'coordinator', path: '/seat/coordinator' });
  const seat = cellSeat(board, { lane: 'core', path: '/seat/builder' });
  const { item_id: id } = cellItem(board, { lane: 'core', title: 'Shadowed claim', criterion: '1. the claim is recorded [test].', route: 'strong', check: 'true' });
  const claim = () => store.claim(board, id, { agentId: seat.id, lane: 'core', leaseMs: 60 * 60_000, freeze: () => ({ text: 'frozen', digest: 'shadow-digest' }) });
  return { board, id, claim };
}

test('clause 1: with moves.shadow off (the default) a claim records no shadow compare [C7,#8376]', t => {
  const { board, claim } = claimable(t);
  claim();
  assert.equal(store.readShadow(board, 'claim'), null);
});

test('clause 2: with moves.shadow on, a matching claim adds one compare and no disagreement to the claim table\'s counts [C7,#8376]', t => {
  const { board, claim } = claimable(t, true);
  claim();
  const counts = store.readShadow(board, 'claim');
  assert.equal(counts.compared, 1, 'the claim was compared once');
  assert.equal(counts.disagreed, 0, `the claim table agreed: ${JSON.stringify(counts.last)}`);
  assert.equal(counts.since, new Date(AT).toISOString());
});

test('clause 3: with moves.shadow on, a claim whose table answer differs adds one disagreement with the item id and the differing field [C7,#8376]', t => {
  const { board, id } = claimable(t, true);
  const hook = store.shadowHook(board, 'claimShadow', 'claim', store.claimDiffers, () => false);
  const event = { kind: 'claim', by: 'core-1', detail: JSON.stringify({ leaseUntil: 1, digest: 'd' }) };
  hook({ id, decided: { events: [{ kind: 'claim', by: 'core-1', detail: { leaseUntil: 2, digest: 'd' } }] }, wrote: [event] });
  hook({ id, decided: { refused: { code: 'NOT_OPEN' } }, wrote: [event] });
  const counts = store.readShadow(board, 'claim');
  assert.equal(counts.compared, 2);
  assert.equal(counts.disagreed, 2);
  assert.deepEqual(counts.last.map(({ id: item, differs }) => ({ item, differs })), [{ item: id, differs: 'events.0.detail.leaseUntil' }, { item: id, differs: 'refused' }]);
});
