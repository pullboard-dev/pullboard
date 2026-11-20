/** The after-gate list joins item_after, is marked apart from plain --after ids, and passes the same dependency checks [C7]. */
// fixture-subject: addItem (a store unit test of the after-gate list over seeded items)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import { withdraw } from '../../../../src/io/board/withdraw.js';
import { afterGateIds } from '../../../../src/io/board/item/after-gate.js';
import { setAfterGate } from '../../../../src/io/board/item/after-gate.js';
import { readBoardMeta } from '../../../../src/io/board/meta.js';

/** A board with a coordinator and a core seat, and an `add` that files one item and returns its id. */
function seeded(t) {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  store.register(board, { lane: 'core', path: '/core', route: 'strong' });
  const add = (title, extra = {}) => store.addItem(board, { by: 'coordinator', lane: 'core', title, route: 'strong', ...extra });
  const after = id => store.getItem(board, id).item_after;
  return { board, add, after };
}

test('store.io-board-item-after-gate.writes-and-reads-back: clause 1: setAfterGate writes the ids into item_after and an after_gate marker, afterGateIds returns them, and a plain after id never appears there [C7]', t => {
  const { board, add, after } = seeded(t);
  const plain = add('Plain prerequisite');
  const gate = add('Gate prerequisite');
  const item = add('Waits on both', { after: [plain] });
  assert.deepEqual(afterGateIds(board, item), []);
  assert.deepEqual(setAfterGate(board, item, [gate]), [gate]);
  assert.deepEqual(afterGateIds(board, item), [gate]);
  assert.equal(after(item), `${plain},${gate}`);
  assert.equal(readBoardMeta(board.db, `after_gate:${item}`), JSON.stringify([gate]));
  setAfterGate(board, item, []);
  assert.deepEqual(afterGateIds(board, item), []);
  assert.equal(after(item), String(plain), 'clearing the gate list leaves the plain after id');
});

test('store.io-board-item-after-gate.refuses-bad-ids: clause 2: an unknown or withdrawn id is refused and an id that reaches the item through its own dependencies is refused DEPENDENCY_CYCLE [C7]', t => {
  const { board, add, after } = seeded(t);
  const item = add('The item');
  const gone = add('Withdrawn prerequisite');
  withdraw(board, gone, { agentId: 'coordinator', reason: 'fixture withdrawal' });
  const downstream = add('Waits on the item', { after: [item] });
  assert.throws(() => setAfterGate(board, item, [9999]), { code: 'NO_ITEM' });
  assert.throws(() => setAfterGate(board, item, [gone]), { code: 'WITHDRAWN' });
  assert.throws(() => setAfterGate(board, item, [downstream]), { code: 'DEPENDENCY_CYCLE' });
  assert.deepEqual(afterGateIds(board, item), []);
  assert.equal(after(item), '', 'a refused list changes nothing');
});

test('store.io-board-item-after-gate.add-and-edit-carry-it: clause 3: addItem and editItem with afterGate set the list, check the combined ids, and a new plain after list keeps the gate ids [C7]', t => {
  const { board, add, after } = seeded(t);
  const first = add('First');
  const second = add('Second');
  const added = add('Added with a gate', { afterGate: [first] });
  assert.deepEqual(afterGateIds(board, added), [first]);
  assert.equal(after(added), String(first));
  store.editItem(board, added, { agentId: 'coordinator', afterGate: [second] });
  assert.deepEqual(afterGateIds(board, added), [second]);
  assert.equal(after(added), String(second));
  store.editItem(board, added, { agentId: 'coordinator', after: [first] });
  assert.deepEqual(afterGateIds(board, added), [second], 'a plain after edit keeps the gate list');
  assert.equal(after(added), `${first},${second}`);
  const downstream = add('Waits on added', { after: [added] });
  assert.throws(() => store.editItem(board, added, { agentId: 'coordinator', afterGate: [downstream] }), { code: 'DEPENDENCY_CYCLE' });
  assert.throws(() => add('Cycle through add', { afterGate: [9999] }), { code: 'NO_ITEM' });
});
