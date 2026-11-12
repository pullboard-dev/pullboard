/** A first baseline green on main holds its item when main's checks.provesNothing is "hold" (#5709) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { cellBoard } from '../../fixtures/cell.js';
import { cellItem } from '../../fixtures/cell.js';

const MAIN = 'a'.repeat(40);

/** An in-memory board with one item whose check awaits its first baseline. */
function pendingItem(t, request) {
  const board = cellBoard(t, ':memory:');
  const expected = { command: 'check-green', main: MAIN, result: 'pending', request };
  const id = cellItem(board, { lane: 'web', title: 'Already passes', check: expected.command, checkBaseline: expected }).item_id;
  return { board, id, expected };
}

test('clause 3: a green first baseline under the hold setting holds the item with the named reason, so next never offers it [C7]', t => {
  const { board, id, expected } = pendingItem(t, '66666666-6666-4666-8666-666666666666');
  assert.equal(store.completeCheckBaseline(board, id, { agentId: 'coordinator', expected,
    baseline: { command: expected.command, main: MAIN, result: 'green' }, holdProvesNothing: true }), true);
  assert.equal(store.getItem(board, id).item_hold_reason, 'check passes on main; edit the bar');
  assert.equal(store.nextFor(board, { agentId: 'web-1', lane: 'web' }).item, null, 'a held item is not offered');
});

test('clause 3: without the hold setting, or with a red baseline, the item stays open [C7]', t => {
  const quiet = pendingItem(t, '77777777-7777-4777-8777-777777777777');
  store.completeCheckBaseline(quiet.board, quiet.id, { agentId: 'coordinator', expected: quiet.expected,
    baseline: { command: quiet.expected.command, main: MAIN, result: 'green' } });
  assert.equal(store.getItem(quiet.board, quiet.id).item_hold_reason ?? null, null, 'warn keeps a green check offered');
  const red = pendingItem(t, '88888888-8888-4888-8888-888888888888');
  store.completeCheckBaseline(red.board, red.id, { agentId: 'coordinator', expected: red.expected,
    baseline: { command: red.expected.command, main: MAIN, result: 'red' }, holdProvesNothing: true });
  assert.equal(store.getItem(red.board, red.id).item_hold_reason ?? null, null, 'a red baseline proves the check fails first');
});
