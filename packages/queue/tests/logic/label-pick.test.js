/** A pure function picks the item a label below its minimum should take next [N2,B13,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cappedLabelsOf } from '../../index.js';
import { firstUnderLabelMax } from '../../index.js';
import { pickForLabelMinimum } from '../../index.js';

const item = (id, labels, extra = {}) => ({ item_id: id, item_labels: labels, ...extra });
const held = (id, labels, owner) => item(id, labels, { item_status: 'claimed', item_owner: owner });

test('queue.label-pick.minimum-yields-top: clause 1: a label below its minimum yields the top servable item carrying it, and none once every minimum is met [C7]', () => {
  const declared = { docs: { min: 1 } };
  const candidates = [item(1, ['ui']), item(2, ['docs']), item(3, ['docs'])];
  assert.equal(pickForLabelMinimum(declared, candidates, candidates)?.item_id, 2);
  const met = [held(9, ['docs'], 'a1'), ...candidates];
  assert.equal(pickForLabelMinimum(declared, met, candidates), null);
  assert.equal(pickForLabelMinimum({}, candidates, candidates), null);
});

test('queue.label-pick.maximum-and-closed: clause 2: a label at its maximum is never picked, and a closed milestone never fills a minimum [C7]', () => {
  const candidates = [item(2, ['docs'])];
  const atMax = [held(9, ['docs'], 'a1')];
  assert.equal(pickForLabelMinimum({ docs: { min: 2, max: 1 } }, [...atMax, ...candidates], candidates), null);
  const closed = [item(2, ['docs'], { milestoneOpen: false }), item(3, ['docs'])];
  assert.equal(pickForLabelMinimum({ docs: { min: 1 } }, closed, closed)?.item_id, 3);
  assert.equal(pickForLabelMinimum({ docs: { min: 1 } }, [closed[0]], [closed[0]]), null);
});

test('queue.label-pick.skips-capped: clause 1: firstUnderLabelMax skips an item whose label is at its max and cappedLabelsOf names it [C7,#9165]', () => {
  const holder = { item_id: 1, item_status: 'claimed', item_owner: 'a', item_labels: ['docs'] };
  const pinned = { item_id: 2, item_status: 'open', item_labels: ['docs'] };
  const plain = { item_id: 3, item_status: 'open', item_labels: [] };
  const declared = { docs: { max: 1 } };
  const items = [holder, pinned, plain];
  assert.deepEqual(cappedLabelsOf(declared, items, pinned), ['docs']);
  assert.equal(firstUnderLabelMax(declared, items, [pinned, plain])?.item_id, 3);
  assert.equal(firstUnderLabelMax(declared, items, [pinned]), null);
  assert.equal(firstUnderLabelMax({}, items, [pinned, plain])?.item_id, 2);
});
