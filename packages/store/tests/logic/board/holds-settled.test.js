/** A hold is settled once every item its reason names is done, and a parent once all children are [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settledHoldReason } from '../../../src/logic/board/holds.js';
import { parentHoldSettled } from '../../../src/logic/board/holds.js';

const statuses = { 1: 'landed', 2: 'withdrawn', 3: 'open', 4: 'landed' };
const statusOf = id => statuses[id];

test('clause 1: settledHoldReason is true only when it names an item and every named item is landed or withdrawn [C7]', () => {
  assert.equal(settledHoldReason('waiting on #1', statusOf), true);
  assert.equal(settledHoldReason('after #1 and #2, also #1 again', statusOf), true);
  assert.equal(settledHoldReason('after #1 and #3', statusOf), false);
});

test('clause 2: a reason naming an open item, or no item, is not settled [C7]', () => {
  assert.equal(settledHoldReason('waiting on #3', statusOf), false);
  assert.equal(settledHoldReason('waiting on the person', statusOf), false);
  assert.equal(settledHoldReason('', statusOf), false);
  assert.equal(settledHoldReason(null, statusOf), false);
  assert.equal(settledHoldReason('see #99', statusOf), false);
});

test('clause 3: parentHoldSettled needs at least one child and every child landed or withdrawn [C7]', () => {
  assert.equal(parentHoldSettled(['landed', 'withdrawn']), true);
  assert.equal(parentHoldSettled(['landed', 'open']), false);
  assert.equal(parentHoldSettled([]), false);
});
