/** Typed item fields: text, choice and number values store and read back with their type, a wrong type is refused, and the setting off changes nothing [C7,#9350]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../fixtures/cell-board.js';
import { register } from '../../../../../store/index.js';
import { addItem } from '../../../../../store/index.js';
import { declareItemField } from '../../../../../store/index.js';
import { setItemField } from '../../../../../store/index.js';
import { itemFields } from '../../../../../store/index.js';

const clock = { now: () => new Date() };

/** A board with one item. */
function boardWithItem(t) {
  const board = cellBoard(t, ':memory:', clock);
  register(board, { lane: 'coordinator', path: '/coordinator' });
  register(board, { lane: 'core', path: '/strong', route: 'strong' });
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'Carry fields', route: 'strong' });
  return { board, id };
}

const ON = { enabled: true };
const tables = board => board.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);

test('clause 1: with items.typedFields on, number, choice and text fields store and read back with their type [C7,#9350]', (t) => {
  const { board, id } = boardWithItem(t);
  declareItemField(board, { ...ON, by: 'coordinator', name: 'points', type: 'number' });
  declareItemField(board, { ...ON, by: 'coordinator', name: 'size', type: 'choice', choices: ['small', 'large'] });
  declareItemField(board, { ...ON, by: 'coordinator', name: 'note', type: 'text' });
  setItemField(board, { ...ON, by: 'core', id, name: 'points', value: 3 });
  setItemField(board, { ...ON, by: 'core', id, name: 'size', value: 'large' });
  setItemField(board, { ...ON, by: 'core', id, name: 'note', value: 'ships with the view' });
  assert.deepEqual(itemFields(board, id, ON), [
    { name: 'note', type: 'text', value: 'ships with the view' },
    { name: 'points', type: 'number', value: 3 },
    { name: 'size', type: 'choice', value: 'large' },
  ]);
  assert.strictEqual(typeof itemFields(board, id, ON).find(field => field.name === 'points').value, 'number', 'a number reads back as a number');
});

test('clause 2: a value of the wrong type is refused with FIELD_TYPE and nothing is stored [C7,#9350]', (t) => {
  const { board, id } = boardWithItem(t);
  declareItemField(board, { ...ON, by: 'coordinator', name: 'points', type: 'number' });
  declareItemField(board, { ...ON, by: 'coordinator', name: 'size', type: 'choice', choices: ['small', 'large'] });
  const refused = (call) => assert.throws(() => setItemField(board, { ...ON, by: 'core', id, ...call }), (error) => error.code === 'FIELD_TYPE' && /\S/u.test(error.next ?? error.message));
  refused({ name: 'points', value: 'three' });
  refused({ name: 'size', value: 'medium' });
  assert.deepEqual(itemFields(board, id, ON), [], 'a refused value leaves no row');
  setItemField(board, { ...ON, by: 'core', id, name: 'size', value: 'small' });
  refused({ name: 'size', value: 7 });
  assert.deepEqual(itemFields(board, id, ON), [{ name: 'size', type: 'choice', value: 'small' }], 'a refused value keeps the earlier one');
});

test('clause 3: with items.typedFields off the board gains no table and every field call is refused or empty [C7,#9350]', (t) => {
  const { board, id } = boardWithItem(t);
  const before = tables(board);
  assert.throws(() => declareItemField(board, { by: 'coordinator', name: 'points', type: 'number' }), (error) => error.code === 'FIELDS_OFF');
  assert.throws(() => setItemField(board, { by: 'core', id, name: 'points', value: 3 }), (error) => error.code === 'FIELDS_OFF');
  assert.deepEqual(itemFields(board, id), []);
  assert.deepEqual(tables(board), before, 'no table was made');
  assert.equal(board.db.prepare('SELECT item_title FROM item WHERE item_id=?').get(id).item_title, 'Carry fields', 'the item row reads as before');
});
