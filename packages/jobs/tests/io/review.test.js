/** A review reservation is a lease on the item's review job: one reviewer at a time, lapsing and releasing with a trail [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { jobView } from '../../index.js';
import { LEASE_MS } from '../../index.js';
import { reclaimLapsedReviews } from '../../index.js';
import { releaseReview } from '../../index.js';
import { renewReview } from '../../index.js';
import { reserveReview } from '../../index.js';
import { reviewJobId } from '../../index.js';
import { reviewOffer } from '../../index.js';

const database = t => cellBoard(t, ':memory:').db;

test('jobs.review.named-by-item: a review job is named by its item, and a bad item or reviewer is refused [C7]', t => {
  assert.equal(reviewJobId(12), 'review:12');
  for (const bad of [0, -1, 1.5, '3', null]) assert.throws(() => reviewJobId(bad), error => error.code === 'REVIEW_ITEM');
  assert.throws(() => reserveReview(database(t), 5, ''), error => error.code === 'REVIEW_RESERVER');
});

test('jobs.review.reserve-one-reviewer: reserveReview gives the review to one reviewer and names the holder to a second [C7]', t => {
  const db = database(t);
  assert.deepEqual(reserveReview(db, 5, 'r1', { now: 1000 }), { reserved: true, holder: 'r1' });
  assert.deepEqual(reserveReview(db, 5, 'r2', { now: 1500 }), { reserved: false, holder: 'r1' });
  const job = jobView(db, 'review:5');
  assert.equal(job.kind, 'review');
  assert.equal(job.item, 5);
  assert.deepEqual(job.steps.map(step => [step.name, step.payload]), [['reserved', { reviewer: 'r1' }]]);
  assert.equal(job.leaseUntil, 1000 + LEASE_MS);
});

test('jobs.review.renew-holder-only: renewReview extends the holder\'s reservation only [C7]', t => {
  const db = database(t);
  reserveReview(db, 5, 'r1', { now: 1000, leaseMs: 100 });
  assert.equal(renewReview(db, 5, 'r2', { now: 1050 }), false);
  assert.equal(renewReview(db, 5, 'r1', { now: 1050, leaseMs: 400 }), true);
  assert.equal(jobView(db, 'review:5').leaseUntil, 1450);
});

test('jobs.review.lapsed-reclaimed: a lapsed reservation is reclaimed with a lapsed step and offered again, and a fresh sighting of the reviewer extends it instead [C7]', t => {
  const db = database(t);
  reserveReview(db, 5, 'r1', { now: 1, leaseMs: 100 });
  reserveReview(db, 6, 'r2', { now: 1, leaseMs: 100 });
  const seen = reviewer => (reviewer === 'r2' ? 900 : null);
  const reclaimed = reclaimLapsedReviews(db, { now: 1000, leaseMs: 500, seen });
  assert.deepEqual(reclaimed, [{ item: 5, reviewer: 'r1', lapsedMs: 899 }]);
  assert.equal(jobView(db, 'review:6').leaseOwner, 'r2', 'seen alive 100 ms ago, so it keeps the review');
  assert.equal(jobView(db, 'review:6').leaseUntil, 1400);
  const job = jobView(db, 'review:5');
  assert.equal(job.leaseOwner, null);
  assert.equal(job.attempt, 1);
  assert.deepEqual(job.steps.map(step => step.name), ['reserved', 'lapsed']);
  const offer = reviewOffer(db, 5, { now: 1001 });
  assert.deepEqual([offer.offered, offer.holder], [true, null]);
  assert.deepEqual(offer.lapses.map(lapse => [lapse.reviewer, lapse.lapsedMs]), [['r1', 899]]);
  assert.deepEqual(reserveReview(db, 5, 'r3', { now: 1002 }), { reserved: true, holder: 'r3' });
  assert.deepEqual(jobView(db, 'review:5').steps.map(step => [step.name, step.seq]), [['reserved', 0], ['lapsed', 0], ['reserved', 1]], 'each attempt writes its own steps');
});

test('jobs.review.release-names-holder: releaseReview frees a held review and says who held it, and answers null when nobody did [C7]', t => {
  const db = database(t);
  assert.equal(releaseReview(db, 9), null, 'no job at all');
  reserveReview(db, 9, 'r1', { now: 1000 });
  assert.equal(releaseReview(db, 9, { now: 1001 }), 'r1');
  assert.equal(releaseReview(db, 9, { now: 1002 }), null, 'a done job is left alone');
  const job = jobView(db, 'review:9');
  assert.deepEqual([job.leaseOwner, job.leaseUntil, job.attempt, job.step], [null, 0, 1, 'done']);
  assert.deepEqual(job.steps.map(step => step.name), ['reserved', 'released']);
});

test('jobs.review.offer-names-holder: reviewOffer offers an item nobody holds and names the live holder otherwise [C7]', t => {
  const db = database(t);
  assert.deepEqual(reviewOffer(db, 3), { offered: true, holder: null, lapses: [] });
  reserveReview(db, 3, 'r1', { now: 1000, leaseMs: 100 });
  assert.deepEqual(reviewOffer(db, 3, { now: 1100 }), { offered: false, holder: 'r1', lapses: [] });
  assert.deepEqual(reviewOffer(db, 3, { now: 1101 }), { offered: true, holder: null, lapses: [] }, 'a lapsed lease offers the review even before it is reclaimed');
});

test('jobs.review.release-marks-done: SM5: releaseReview releases a live holder, then marks the review job done; a lapsed or missing job ends without a released step [C7]', t => {
  const db = database(t);
  assert.equal(releaseReview(db, 4), null, 'no job at all');
  reserveReview(db, 4, 'r1', { now: 1000 });
  assert.equal(releaseReview(db, 4, { now: 1001 }), 'r1');
  const ended = jobView(db, 'review:4');
  assert.deepEqual([ended.step, ended.leaseOwner, ended.leaseUntil], ['done', null, 0]);
  assert.deepEqual(ended.steps.map(step => step.name), ['reserved', 'released']);
  assert.equal(releaseReview(db, 4, { now: 1002 }), null, 'a done job is left alone');
  reserveReview(db, 6, 'r1', { now: 1, leaseMs: 10 });
  reclaimLapsedReviews(db, { now: 100 });
  assert.equal(releaseReview(db, 6, { now: 101 }), null);
  assert.deepEqual([jobView(db, 'review:6').step, jobView(db, 'review:6').steps.map(step => step.name)], ['done', ['reserved', 'lapsed']]);
  assert.deepEqual(reserveReview(db, 4, 'r2', { now: 2000 }), { reserved: true, holder: 'r2' }, 'a resubmitted item is reserved again');
  assert.equal(jobView(db, 'review:4').step, 'reserved');
});

test('jobs.review.reclaim-needs-submitted: SM5: reclaimLapsedReviews never extends a lease whose item is not submitted, however fresh the heartbeat [C7]', t => {
  const db = database(t);
  reserveReview(db, 5, 'r1', { now: 1, leaseMs: 100 });
  reserveReview(db, 6, 'r2', { now: 1, leaseMs: 100 });
  const reclaimed = reclaimLapsedReviews(db, { now: 1000, leaseMs: 500, seen: () => 999, submitted: item => item === 6 });
  assert.deepEqual(reclaimed, [{ item: 5, reviewer: 'r1', lapsedMs: 899 }], 'item 5 left review, so its heartbeating reviewer loses it');
  assert.equal(jobView(db, 'review:5').leaseOwner, null);
  assert.deepEqual([jobView(db, 'review:6').leaseOwner, jobView(db, 'review:6').leaseUntil], ['r2', 1499], 'item 6 is still submitted');
});
