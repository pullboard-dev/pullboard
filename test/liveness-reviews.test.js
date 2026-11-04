/** Release review reservations when their agent heartbeat has been absent for two minutes [C7,V15]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { cli, fixture } from './next-take-fixture.js';

/** Create a review seat with an explicit independent parent, so session guards do not mask lease behavior. */
function independentReviewer(box, name) {
  const path = join(box.root, '..', `liveness-review-${name}`);
  box.git(box.root, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
  const id = store.register(box.board, { lane: 'review', path, parent: `liveness-review-${name}`, family: 'Family Beta', route: 'strong' });
  store.heartbeatSeat(box.board, id);
  return { id, path };
}

test('a review reservation with no heartbeat for two minutes is available to the next reviewer [C7,V15]', async t => {
  const box = await fixture(t);
  const id = box.add('Review reservation whose owner went away');
  box.submit(id);
  const holder = independentReviewer(box, 'holder-expiring');
  const successor = independentReviewer(box, 'successor');
  const reserved = await cli(box, holder.path, ['next', '--verify', String(id)]);
  assert.equal(reserved.code, 0, reserved.out + reserved.err);
  assert.equal(reserved.document.item.item_id, id);
  assert.equal(store.getItem(box.board, id).item_review_by, holder.id);

  box.advance(2 * 60_000 + 1);
  const reclaimed = await cli(box, successor.path, ['next', '--verify']);
  assert.equal(reclaimed.code, 0, reclaimed.out + reclaimed.err);
  assert.equal(reclaimed.document.item.item_id, id, 'the submitted review returns to the queue');
  assert.equal(reclaimed.document.review, true);
  assert.equal(store.getItem(box.board, id).item_review_by, successor.id, 'the new reviewer takes the expired reservation');
});

test('a reviewer heartbeat within two minutes keeps its reservation held [C7,V15]', async t => {
  const box = await fixture(t);
  const id = box.add('Review reservation whose owner remains active');
  box.submit(id);
  const holder = independentReviewer(box, 'holder-live');
  const challenger = independentReviewer(box, 'challenger');
  const reserved = await cli(box, holder.path, ['next', '--verify', String(id)]);
  assert.equal(reserved.code, 0, reserved.out + reserved.err);
  box.advance(2 * 60_000);
  store.heartbeatSeat(box.board, holder.id);
  assert.equal(store.reviewHolder(box.board, store.getItem(box.board, id)), holder.id,
    'a current heartbeat keeps the live reviewer reservation');
  assert.throws(() => store.reserveReview(box.board, id, {
    agentId: challenger.id, leaseMs: 30 * 60_000, policy: 'any',
  }), error => error.code === 'REVIEW_HELD');
});
