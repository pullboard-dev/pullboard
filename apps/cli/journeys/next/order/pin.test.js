/** Next order: a milestone pin breaks a rank tie [C7,#8785]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { addMilestone } from '../../../../../packages/store/index.js';
import { orderMilestoneItems } from '../../../../../packages/store/index.js';
import { boardFixture } from '../../../tests/fixtures/next/order.js';
import { readyItem } from '../../../tests/fixtures/next/order.js';

test('clause 1: next offers a pinned item before an older unpinned item of equal rank [C7]', t => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const add = title => readyItem(board, title);
  const older = add('Older unpinned work');
  const pinned = add('Newer pinned work');
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'release', items: [older, pinned] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, older, 'with no pin, the older item of equal rank leads');
  orderMilestoneItems(board, 'release', { agentId: 'coordinator', reason: 'Pin the newer item', items: [pinned], place: 'pin' });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, pinned, 'the pinned item comes before the older unpinned item');
});
