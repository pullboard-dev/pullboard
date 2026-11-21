import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutItem } from '../../src/logic/cut.js';

const BIG = { criterion: '1. alpha works [test] 2. beta works [test] 3. gamma works [test]', check: 'node check.js', route: 'mid', expectedMinutes: 90 };

test('items.cut.child-per-clause: clause 1: an over-budget item with a check is cut into one child per clause, each within budget and inheriting the check [C7]', () => {
  const { children, note } = cutItem(BIG, 30);
  assert.equal(note, null);
  assert.equal(children.length, 3);
  assert.deepEqual(children.map(child => child.criterion), ['alpha works [test]', 'beta works [test]', 'gamma works [test]']);
  for (const child of children) {
    assert.ok(child.expectedMinutes <= 30);
    assert.equal(child.check, BIG.check);
  }
});

test('items.cut.no-check-noted: clause 2: an over-budget item with no check is not cut and gets a note asking for a check, route unchanged [C7]', () => {
  const item = { ...BIG, check: undefined };
  const result = cutItem(item, 30);
  assert.deepEqual(result.children, []);
  assert.match(result.note, /no check/u);
  assert.equal(result.item.route, 'mid');
  assert.equal(result.item, item);
});

test('items.cut.within-budget-unchanged: clause 3: an item at or under the budget is returned unchanged [C7]', () => {
  for (const expectedMinutes of [30, 10, null]) {
    const item = { ...BIG, expectedMinutes };
    assert.deepEqual(cutItem(item, 30), { item, children: [], note: null });
  }
});
