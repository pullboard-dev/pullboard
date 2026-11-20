/** A fixed Main red names the open items whose red gate failed on it [C7,#1269]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemsFailedOn } from '../../../src/logic/audit/main-red.js';

const RED = { file: 'packages/a/tests/x.test.js', name: 'clause 1: x holds' };

test('items.main-red-notify.names-items-failed-on-the-red: clause 1: itemsFailedOn returns each item whose red gate failures include the red file and case [C7]', () => {
  const itemReds = [
    { id: 7, failures: [{ file: 'packages/b/tests/y.test.js', name: 'clause 2: y' }, { ...RED }] },
    { id: 9, failures: [{ ...RED }] },
  ];
  assert.deepEqual(itemsFailedOn(RED, itemReds), [7, 9]);
});

test('items.main-red-notify.skips-other-files-and-cases: clause 1: itemsFailedOn returns no item whose failures name another file or case [C7]', () => {
  const itemReds = [
    { id: 1, failures: [{ file: RED.file, name: 'clause 2: another case' }] },
    { id: 2, failures: [{ file: 'packages/a/tests/z.test.js', name: RED.name }] },
    { id: 3, failures: [] },
  ];
  assert.deepEqual(itemsFailedOn(RED, itemReds), []);
});
