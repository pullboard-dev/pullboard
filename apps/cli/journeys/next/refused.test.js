/** A seat waiting for work receives a newly available pinned item before next's active routing timeout [C7,N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addMilestone,
  orderMilestoneItems,
} from '../../../../packages/store/index.js';
import {
  cli,
  fixture,
} from '../../tests/fixtures/next/take.js';

test('next --wait 30 gives the waiting seat an open pinned item [C7,N2]', async t => {
  const box = await fixture(t);
  let item;
  const waiting = cli(box, box.seats.actor.path, ['next', '--wait', '30']);
  setTimeout(() => {
    item = box.add('A pinned item becomes eligible while the seat waits');
    addMilestone(box.board, { agentId: 'coordinator', reason: 'Arrange the wait fixture', name: 'wait-pin', items: [item] });
    orderMilestoneItems(box.board, 'wait-pin', { agentId: 'coordinator', items: [item], place: 'pin', reason: 'Prioritize the waiting seat fixture' });
  }, 100);

  const result = await waiting;
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(result.document.item.item_id, item);
  assert.equal(result.document.item.item_status, 'open', 'ordinary next offers the eligible item without claiming it');
});
