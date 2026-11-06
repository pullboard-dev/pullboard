/** A Main red item whose named test already passes on current main is closed with the recorded run, never offered [C7,H24]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { passingMainReds } from '../packages/landing/index.js';

const main = 'a'.repeat(40);
const file = 'test/x.test.js';
const item = (id, extra = {}) => ({ item_id: id, item_status: 'open', item_title: `Main red: ${file}`, ...extra });

test('clause 1: an open Main red item whose file is green on current main is closed with the recorded run [C7,H24]', () => {
  const found = passingMainReds([item(1)], main, { [main]: { [file]: { result: 'green', receiptId: 'run-1' } } });
  assert.deepEqual(found, [{ item: 1, file, receiptId: 'run-1', main }]);
});

test('clause 2: an item whose named case still fails on current main is offered as today [C7,H24]', () => {
  const entries = { [main]: { [file]: { result: 'red', receiptId: 'run-2', failures: [{ name: 'x case' }] } } };
  const named = { item_check_baseline: { testEvidence: { failedCases: [{ file, name: 'x case' }] } } };
  assert.deepEqual(passingMainReds([item(1, named), item(2)], main, entries), []);
  const fixed = { [main]: { [file]: { result: 'red', failures: [{ name: 'other case' }] } } };
  assert.deepEqual(passingMainReds([item(1, named)], main, fixed).map(row => row.item), [1]);
});

test('clause 3: the check reads only recorded runs for the current main and adds none of its own [C7,H24]', () => {
  assert.deepEqual(passingMainReds([item(1)], main, { ['b'.repeat(40)]: { [file]: { result: 'green' } } }), []);
  assert.deepEqual(passingMainReds([item(1)], main, { [main]: {} }), []);
  assert.deepEqual(passingMainReds([item(1, { item_status: 'claimed' })], main, { [main]: { [file]: { result: 'green' } } }), []);
});
