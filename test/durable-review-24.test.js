/** Durable gate 24/20: review reservations are leases in the jobs cell and lapse on the 2-minute rule [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { privateFixtureFiles } from './fixture-child.js';
import { openBoard, closeBoard } from '../apps/lib/index.js';
import { reserveReview, renewReview, reclaimLapsedReviews, reviewOffer, jobView, LEASE_MS } from '../packages/jobs/index.js';

const files = privateFixtureFiles('pullboard-durable-review-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoard(name, body) {
  const board = openBoard(join(files.root, `${name}.sqlite`));
  try { return body(board.db); } finally { closeBoard(board); }
}

test('clause 1: a silent reviewer loses the reservation within 2 minutes, the item is offered again and the lapse is recorded [C7]', () => {
  withBoard('lapse', (db) => {
    assert.deepEqual(reserveReview(db, 7, 'rev-a', { now: 1_000 }), { reserved: true, holder: 'rev-a' });
    assert.equal(jobView(db, 'review:7').kind, 'review');
    assert.deepEqual(reserveReview(db, 7, 'rev-b', { now: 10_000 }), { reserved: false, holder: 'rev-a' });
    assert.equal(renewReview(db, 7, 'rev-a', { now: 30_000 }), true);
    const lastBeat = 30_000;
    assert.deepEqual(reclaimLapsedReviews(db, { now: lastBeat + LEASE_MS }), []);
    assert.equal(reviewOffer(db, 7, { now: lastBeat + LEASE_MS }).offered, false);
    const lapsedAt = lastBeat + LEASE_MS + 1;
    assert.ok(lapsedAt - lastBeat <= 2 * 60_000 + 1);
    assert.deepEqual(reclaimLapsedReviews(db, { now: lapsedAt }), [{ item: 7, reviewer: 'rev-a', lapsedMs: 1 }]);
    const offer = reviewOffer(db, 7, { now: lapsedAt });
    assert.equal(offer.offered, true);
    assert.equal(offer.holder, null);
    assert.deepEqual(offer.lapses, [{ reviewer: 'rev-a', lapsedMs: 1, at: lapsedAt }]);
    assert.equal(renewReview(db, 7, 'rev-a', { now: lapsedAt + 1 }), false);
    assert.deepEqual(reserveReview(db, 7, 'rev-b', { now: lapsedAt + 2 }), { reserved: true, holder: 'rev-b' });
    assert.deepEqual(jobView(db, 'review:7').steps.map(step => step.name), ['reserved', 'lapsed', 'reserved']);
  });
});

test('clause 1: a reviewer that keeps renewing keeps the reservation and nothing is reclaimed [C7]', () => {
  withBoard('live', (db) => {
    reserveReview(db, 8, 'rev-a', { now: 1_000 });
    for (let at = 60_000; at <= 10 * 60_000; at += 60_000) {
      assert.equal(renewReview(db, 8, 'rev-a', { now: at }), true);
      assert.deepEqual(reclaimLapsedReviews(db, { now: at + 1 }), []);
    }
    assert.equal(reviewOffer(db, 8, { now: 10 * 60_000 + 1 }).holder, 'rev-a');
    assert.deepEqual(reviewOffer(db, 9, { now: 0 }), { offered: true, holder: null, lapses: [] });
  });
});
