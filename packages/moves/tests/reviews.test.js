/** Release review reservations when their agent heartbeat has been absent for two minutes [C7,V15]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import * as store from '../../store/index.js';
import { fixture } from './fixtures/next.js';
import { next } from './fixtures/next.js';

/** Create a review seat with an explicit independent parent, so session guards do not mask lease behavior. */
function independentReviewer(box, name) {
  const path = join(box.project.dir, `liveness-review-${name}`);
  mkdirSync(path);
  const id = store.register(box.board, { lane: 'review', path, parent: `liveness-review-${name}`, family: 'Family Beta', route: 'strong' });
  store.heartbeatSeat(box.board, id);
  return { id, lane: 'review', path };
}

/** Remove a reviewer's private heartbeat row to model a process that has exited. */
function forgetHeartbeat(box, id) {
  const file = box.board.db.prepare("PRAGMA database_list").all().find(row => row.name === 'main').file + '.presence.sqlite';
  const presence = new DatabaseSync(file);
  try {
    presence.prepare('DELETE FROM heartbeat WHERE seat=?').run(JSON.stringify([store.boardId(box.board), id]));
  } finally { presence.close(); }
}

test('moves.review.stale-heartbeat-available: clause 1: a review reservation with no heartbeat for two minutes is available to the next reviewer [C7,V15]', async t => {
  const box = fixture(t, { reviewers: true });
  const id = box.add('Review reservation whose owner went away');
  box.submit(id);
  const holder = independentReviewer(box, 'holder-expiring');
  const successor = independentReviewer(box, 'successor');
  box.as(holder);
  const reserved = await next(box, { verify: true, verifyId: String(id) });
  assert.equal(reserved.item.item_id, id);
  assert.equal(store.getItem(box.board, id).item_review_by, holder.id);

  box.advance(2 * 60_000 + 1);
  box.as(successor);
  const reclaimed = await next(box, { verify: true });
  assert.equal(reclaimed.item.item_id, id, 'the submitted review returns to the queue');
  assert.equal(reclaimed.review, true);
  assert.equal(store.getItem(box.board, id).item_review_by, successor.id, 'the new reviewer takes the expired reservation');
});

test('moves.review.fresh-heartbeat-held: clause 2: a reviewer heartbeat within two minutes keeps its reservation held [C7,V15]', async t => {
  const box = fixture(t, { reviewers: true });
  const id = box.add('Review reservation whose owner remains active');
  box.submit(id);
  const holder = independentReviewer(box, 'holder-live');
  const challenger = independentReviewer(box, 'challenger');
  box.as(holder);
  await next(box, { verify: true, verifyId: String(id) });
  box.advance(2 * 60_000);
  store.heartbeatSeat(box.board, holder.id);
  assert.equal(store.reviewHolder(box.board, store.getItem(box.board, id)), holder.id,
    'a current heartbeat keeps the live reviewer reservation');
  assert.throws(() => store.reserveReview(box.board, id, {
    agentId: challenger.id, leaseMs: 30 * 60_000, policy: 'any',
  }), error => error.code === 'REVIEW_HELD');
});

test('moves.review.no-heartbeat-releases: clause 1: a reviewer with no heartbeat record releases its reservation before the lease expires [C7,V15]', async t => {
  const box = fixture(t, { reviewers: true });
  const id = box.add('Review reservation whose owner process exited');
  box.submit(id);
  const holder = independentReviewer(box, 'holder-exited');
  const successor = independentReviewer(box, 'successor-after-exit');
  box.as(holder);
  await next(box, { verify: true, verifyId: String(id) });
  assert.ok(Date.parse(store.getItem(box.board, id).item_review_until) > box.clock.now().getTime(), 'the lease itself is still live');

  forgetHeartbeat(box, holder.id);
  box.as(successor);
  const reclaimed = await next(box, { verify: true });
  assert.equal(reclaimed.item.item_id, id, 'the review returns to the queue when its process is gone');
  assert.equal(store.getItem(box.board, id).item_review_by, successor.id, 'the successor takes the reservation');
});
