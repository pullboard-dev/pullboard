/** @pullboard-test-input source-tree */
/** Native Next reserves aged first reviews, never inventing reviewer eligibility [B26,V4]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../store/index.js';
import { fixture } from './next-fixture.js';
import { next } from './next-fixture.js';

/** Change only the private board's recorded opt-in control. */
function setting(box, key, value) {
  return store.setLineSetting(box.board, { agentId: 'coordinator', key, value,
    reason: 'Private first-review dispatch control', window: { windowMinutes: 30 } });
}

test('native next reserves the oldest eligible first review before any new build, including explicit build intent [B26,V4]', async t => {
  const box = fixture(t, { reviewers: true });
  const newer = box.add('Created first but submitted later');
  const old = box.add('Created later but oldest waiting submission'); box.submit(old);
  box.advance(60_000);
  box.submit(newer);
  const build = box.add('Otherwise new build', { brief: 'Files: web/independent.js\nTest: independent work stays open.' });
  setting(box, 'reviewsFirst', true);
  box.advance(16 * 60_000);
  const nativeOffer = store.reviewOffer(box.board, { agentId: box.seats.actor.id, lane: box.seats.actor.lane, policy: 'any', mandatoryOnly: true });
  assert.equal(nativeOffer?.item.item_id, old, JSON.stringify(nativeOffer));
  const selected = await next(box);
  assert.equal(selected.review, true, JSON.stringify(selected));
  assert.equal(selected.item.item_id, old);
  assert.equal(store.getItem(box.board, old).item_review_by, box.seats.actor.id, 'this is a native reservation, not an unreserved offer');
  assert.equal(store.getItem(box.board, build).item_status, 'open');
  const again = await next(box);
  assert.equal(again.item.item_id, old, 'ongoing review stays with its caller');
  box.as('outside');
  const explicit = await next(box, { build: true });
  assert.equal(explicit.item.item_id, newer);
  assert.equal(store.getItem(box.board, newer).item_review_by, box.seats.outside.id);
});

test('a self-ineligible seat builds normally while an eligible seat cannot escape to an out-of-focus build [B26,V4]', async t => {
  const box = fixture(t, { reviewers: true });
  const review = box.add('Current release first review'); box.submit(review);
  const build = box.add('Later release build', { brief: 'Files: web/later.js\nTest: ordinary ineligible-seat fallback.' });
  store.addMilestone(box.board, { agentId: 'coordinator', reason: 'Private current release', name: 'Current', items: [review] });
  store.addMilestone(box.board, { agentId: 'coordinator', reason: 'Private later release', name: 'Later', items: [build] });
  setting(box, 'focusMilestone', { name: 'Current', overflow: true });
  setting(box, 'reviewsFirst', true);
  box.advance(16 * 60_000);
  const planned = store.nextFor(box.board, { agentId: box.seats.builder.id, lane: box.seats.builder.lane, policy: 'any', familyPolicy: 'off' });
  assert.equal(planned.item?.item_id, build, 'ordinary eligibility must retain the self-ineligible build fallback: ' + JSON.stringify(planned));
  box.as('builder');
  const builder = await next(box);
  assert.equal(builder.item.item_id, build, 'native self-review refusal is not waived by the dispatch policy');
  box.as('actor');
  const reviewer = await next(box);
  assert.equal(reviewer.item.item_id, review);
  assert.equal(reviewer.review, true);
  assert.equal(store.getItem(box.board, review).item_review_by, box.seats.actor.id);
});

test('the fifteen-minute boundary, prior reservation and opt-out do not create mandatory first reviews [B26,V4]', t => {
  const box = fixture(t, { reviewers: true });
  const review = box.add('Boundary review'); box.submit(review);
  const who = { agentId: box.seats.actor.id, lane: box.seats.actor.lane, mandatoryOnly: true, policy: 'any' };
  setting(box, 'reviewsFirst', true);
  box.advance(15 * 60_000);
  assert.equal(store.reviewOffer(box.board, who), null);
  box.advance(1);
  assert.equal(store.reviewOffer(box.board, who).item.item_id, review);
  setting(box, 'reviewsFirst', false);
  assert.equal(store.reviewOffer(box.board, who), null);
  setting(box, 'reviewsFirst', true);
  store.reserveReview(box.board, review, { agentId: box.seats.outside.id, leaseMs: 1000, policy: 'any' });
  box.advance(1001);
  assert.equal(store.reviewOffer(box.board, who), null, 'a previously reviewed submission is no longer waiting for its first reviewer');
});
