/** Item labels are computed from the item, never typed, and grant nothing [N2,B13]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { itemLabels } from '../../../../packages/queue/index.js';

test('automatic labels appear without config [N2,B13]', () => {
  const labels = itemLabels({ item_lane: 'core', item_level: 'L2', item_review_tier: 'strict', item_expected_build_minutes: 5 }, { brokenMain: true });
  assert.deepEqual(labels, ['broken-main', 'lane:core', 'level:L2', 'quick-win', 'review:strict']);
  assert.deepEqual(itemLabels({ item_lane: 'view', item_review_tier: 'standard', item_expected_build_minutes: 30 }), ['lane:view']);
});

test('a hand label is kept and the list is sorted [N2,B13]', () => {
  assert.deepEqual(itemLabels({ item_lane: 'core', item_labels: ['zeta', 'alpha', 'alpha'] }), ['alpha', 'lane:core', 'zeta']);
});

test('labels never grant or deny an agent: a typed automatic name is dropped and the item is untouched [N2,B13]', () => {
  const item = Object.freeze({ item_lane: 'core', item_review_tier: 'standard', item_labels: Object.freeze(['review:strict', 'broken-main', 'lane:other', 'quick-win']) });
  assert.deepEqual(itemLabels(item), ['lane:core']);
  assert.deepEqual(item.item_labels, ['review:strict', 'broken-main', 'lane:other', 'quick-win']);
});
