/** A builder seat gets its own build from plain next before any review, and an unstarted review reservation lapses in 5 minutes [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import {
  cli,
  fixture,
} from '../../tests/fixtures/next/take.js';

/** Enable the private board's native first-review dispatch policy. */
function reviewsFirst(box) {
  store.setLineSetting(box.board, { agentId: 'coordinator', key: 'reviewsFirst', value: true,
    reason: 'Private mandatory first-review dispatch control', window: { windowMinutes: 30 } });
}

test('clause 1: a seat holding a claimed build gets that build from plain next, not a review [C7]', async t => {
  const box = await fixture(t);
  const review = box.add('Aged first review waiting');
  box.submit(review);
  const build = box.add('Build this seat holds', { brief: 'Files: web/held-build.js\nTest: the held build is served by plain next.' });
  const claimed = await cli(box, box.seats.actor.path, ['claim', String(build), '--no-next']);
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  reviewsFirst(box);
  box.advance(16 * 60_000);

  const next = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(next.code, 0, next.out + next.err);
  assert.equal(next.document.review, false);
  assert.equal(next.document.item.item_id, build, 'the seat gets its own build, not the review');
  assert.equal(store.getItem(box.board, review).item_review_by, null, 'no review was reserved');
});

test('clause 2: a review reserved by plain next and not started lapses within 5 minutes [C7]', async t => {
  const box = await fixture(t);
  const review = box.add('Aged first review waiting');
  box.submit(review);
  reviewsFirst(box);
  box.advance(16 * 60_000);

  const next = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(next.code, 0, next.out + next.err);
  assert.equal(next.document.review, true);
  const reserved = store.getItem(box.board, review);
  assert.equal(reserved.item_review_by, box.seats.actor.id);
  const lapse = Date.parse(reserved.item_review_until) - box.clock.now().getTime();
  assert.ok(lapse > 0 && lapse <= 5 * 60_000, `the reservation lapses within 5 minutes, not ${lapse} ms`);
});
