/** Related item links: one symmetric free link per pair, no dependency, an unknown item refused, and the setting off changes nothing [C7,#9355]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { register } from '../../../../../store/index.js';
import { addItem } from '../../../../../store/index.js';
import { claim } from '../../../../../store/index.js';
import { relateItems } from '../../../../../store/index.js';
import { relatedLinks } from '../../../../../store/index.js';

const clock = { now: () => new Date() };
const ON = { enabled: true };
const FREEZE = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });
const tables = board => board.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
const afterOf = (board, id) => board.db.prepare('SELECT item_after FROM item WHERE item_id=?').get(id).item_after;

/** A board with two core items and a builder seat. */
function boardWithTwo(t) {
  const board = cellBoard(t, ':memory:', clock);
  register(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = register(board, { lane: 'core', path: '/strong', route: 'strong' });
  const first = addItem(board, { by: 'coordinator', lane: 'core', title: 'First', route: 'strong' });
  const second = addItem(board, { by: 'coordinator', lane: 'core', title: 'Second', route: 'strong' });
  return { board, builder, first, second };
}

test('board.item-related.relating-two-items-stores-one-related: clause 1: relating two items stores one related link, leaves both after lists alone, and relating twice stores one link [C7,#9355]', (t) => {
  const { board, first, second } = boardWithTwo(t);
  const afterBefore = [afterOf(board, first), afterOf(board, second)];
  assert.deepEqual(relateItems(board, { ...ON, by: 'coordinator', a: second, b: first }), { low: first, high: second, created: true });
  assert.deepEqual(relatedLinks(board, first, ON), [second]);
  assert.deepEqual(relatedLinks(board, second, ON), [first], 'the link reads from both ends');
  assert.deepEqual([afterOf(board, first), afterOf(board, second)], afterBefore, 'neither after list changed');
  assert.equal(relateItems(board, { ...ON, by: 'coordinator', a: first, b: second }).created, false, 'the reverse pair is the same link');
  relateItems(board, { ...ON, by: 'coordinator', a: first, b: second });
  assert.equal(board.db.prepare('SELECT count(*) AS n FROM item_related').get().n, 1, 'one link stored');
});

test('board.item-related.relating-unknown-item-refused-with-its: clause 2: relating an unknown item is refused with its next step and a related link never blocks a claim [C7,#9355]', (t) => {
  const { board, builder, first, second } = boardWithTwo(t);
  assert.throws(() => relateItems(board, { ...ON, by: 'coordinator', a: first, b: 9999 }), (error) => error.code === 'NO_SUCH_ITEM' && /pullboard list/u.test(error.next ?? error.message));
  assert.throws(() => relateItems(board, { ...ON, by: 'coordinator', a: first, b: first }), (error) => error.code === 'RELATED_SELF');
  assert.deepEqual(relatedLinks(board, first, ON), [], 'a refused relate stores nothing');
  relateItems(board, { ...ON, by: 'coordinator', a: first, b: second });
  claim(board, second, { agentId: builder, lane: 'core', leaseMs: 60_000, freeze: FREEZE });
  assert.equal(board.db.prepare('SELECT item_owner FROM item WHERE item_id=?').get(second).item_owner, builder, 'the related item was claimed');
});

test('board.item-related.with-items-typedfields-off-the-board: clause 2: with items.typedFields off the board gains no table and relating is refused [C7,#9355]', (t) => {
  const { board, first, second } = boardWithTwo(t);
  const before = tables(board);
  assert.throws(() => relateItems(board, { by: 'coordinator', a: first, b: second }), (error) => error.code === 'RELATED_OFF');
  assert.deepEqual(relatedLinks(board, first), []);
  assert.deepEqual(tables(board), before, 'no table was made');
});
