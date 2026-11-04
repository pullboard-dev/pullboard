/** Release review reservations when their agent heartbeat has been absent for two minutes [C7,V15]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { cli, fixture } from './next-take-fixture.js';

test('a review reservation with no heartbeat for two minutes is available to the next reviewer [C7,V15]', async t => {
  const box = await fixture(t);
  const id = box.add('Review reservation whose owner went away');
  box.submit(id);
  const reserved = await cli(box, box.seats.outside.path, ['next', '--verify', String(id)]);
  assert.equal(reserved.code, 0, reserved.out + reserved.err);
  assert.equal(reserved.document.item.item_id, id);
  assert.equal(store.getItem(box.board, id).item_review_by, box.seats.outside.id);

  box.advance(2 * 60_000 + 1);
  const reclaimed = await cli(box, box.seats.sibling.path, ['next', '--verify']);
  assert.equal(reclaimed.code, 0, reclaimed.out + reclaimed.err);
  assert.equal(reclaimed.document.item.item_id, id, 'the submitted review returns to the queue');
  assert.equal(reclaimed.document.review, true);
  assert.equal(store.getItem(box.board, id).item_review_by, box.seats.sibling.id, 'the new reviewer takes the expired reservation');
});

test('a reviewer heartbeat within two minutes keeps its reservation held [C7,V15]', async t => {
  const box = await fixture(t);
  const id = box.add('Review reservation whose owner remains active');
  box.submit(id);
  const reserved = await cli(box, box.seats.outside.path, ['next', '--verify', String(id)]);
  assert.equal(reserved.code, 0, reserved.out + reserved.err);
  box.advance(2 * 60_000);
  store.heartbeatSeat(box.board, box.seats.outside.id);
  assert.equal(store.reviewHolder(box.board, store.getItem(box.board, id)), box.seats.outside.id,
    'a current heartbeat keeps the live reviewer reservation');
  assert.throws(() => store.reserveReview(box.board, id, {
    agentId: box.seats.sibling.id, leaseMs: 30 * 60_000, policy: 'any',
  }), error => error.code === 'REVIEW_HELD');
});
