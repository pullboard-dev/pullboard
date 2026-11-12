/** A review reservation is a lease on the item's review job: one reviewer at a time, lapsing and releasing with a trail [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { jobView } from '../../index.js';
import { LEASE_MS } from '../../index.js';
import { reclaimLapsedReviews } from '../../index.js';
import { releaseReview } from '../../index.js';
import { renewReview } from '../../index.js';
import { reserveReview } from '../../index.js';
import { reviewJobId } from '../../index.js';
import { reviewOffer } from '../../index.js';

const database = t => cellBoard(t, ':memory:').db;

test('a review job is named by its item, and a bad item or reviewer is refused [C7]', t => {
  assert.equal(reviewJobId(12), 'review:12');
  for (const bad of [0, -1, 1.5, '3', null]) assert.throws(() => reviewJobId(bad), error => error.code === 'REVIEW_ITEM');
  assert.throws(() => reserveReview(database(t), 5, ''), error => error.code === 'REVIEW_RESERVER');
});

test('reserveReview gives the review to one reviewer and names the holder to a second [C7]', t => {
  const db = database(t);
  assert.deepEqual(reserveReview(db, 5, 'r1', { now: 1000 }), { reserved: true, holder: 'r1' });
  assert.deepEqual(reserveReview(db, 5, 'r2', { now: 1500 }), { reserved: false, holder: 'r1' });
  const job = jobView(db, 'review:5');
  assert.equal(job.kind, 'review');
  assert.equal(job.item, 5);
  assert.deepEqual(job.steps.map(step => [step.name, step.payload]), [['reserved', { reviewer: 'r1' }]]);
  assert.equal(job.leaseUntil, 1000 + LEASE_MS);
});

test('renewReview extends the holder\'s reservation only [C7]', t => {
  const db = database(t);
  reserveReview(db, 5, 'r1', { now: 1000, leaseMs: 100 });
  assert.equal(renewReview(db, 5, 'r2', { now: 1050 }), false);
  assert.equal(renewReview(db, 5, 'r1', { now: 1050, leaseMs: 400 }), true);
  assert.equal(jobView(db, 'review:5').leaseUntil, 1450);
});

test('a lapsed reservation is reclaimed with a lapsed step and offered again, and a fresh sighting of the reviewer extends it instead [C7]', t => {
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

test('releaseReview frees a held review and says who held it, and answers null when nobody did [C7]', t => {
  const db = database(t);
  assert.equal(releaseReview(db, 9), null, 'no job at all');
  reserveReview(db, 9, 'r1', { now: 1000 });
  assert.equal(releaseReview(db, 9, { now: 1001 }), 'r1');
  assert.equal(releaseReview(db, 9, { now: 1002 }), null);
  const job = jobView(db, 'review:9');
  assert.deepEqual([job.leaseOwner, job.leaseUntil, job.attempt], [null, 0, 1]);
  assert.deepEqual(job.steps.map(step => step.name), ['reserved', 'released']);
});

test('reviewOffer offers an item nobody holds and names the live holder otherwise [C7]', t => {
  const db = database(t);
  assert.deepEqual(reviewOffer(db, 3), { offered: true, holder: null, lapses: [] });
  reserveReview(db, 3, 'r1', { now: 1000, leaseMs: 100 });
  assert.deepEqual(reviewOffer(db, 3, { now: 1100 }), { offered: false, holder: 'r1', lapses: [] });
  assert.deepEqual(reviewOffer(db, 3, { now: 1101 }), { offered: true, holder: null, lapses: [] }, 'a lapsed lease offers the review even before it is reclaimed');
});
