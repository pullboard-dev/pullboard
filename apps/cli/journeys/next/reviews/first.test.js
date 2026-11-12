/** next --take gives every eligible seat a green, unreserved review before any build [C7,#2992]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../../../../packages/jobs/index.js';
import * as store from '../../../../../packages/store/index.js';
import {
  fixture,
  cli,
} from '../../../tests/fixtures/next/take.js';

/** Record a green gate at the item's submitted head with the proof receipt the production gate writes, as the submit queue does. */
function green(box, id) {
  const item = store.getItem(box.board, id);
  const head = item.item_commit, tree = box.git(box.root, 'rev-parse', `${head}^{tree}`);
  const agentId = box.seats.builder.id;
  recordSubmitHandoff(box.board.db, id, { id: `fixture-${id}`, commit: head, tree, executionCommit: head, executionTree: tree,
    digest: item.item_frozen_digest, agentId, state: 'green' });
  box.board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, ?, ?)')
    .run(box.clock.now().toISOString(), agentId, 'proof-run', id, JSON.stringify({ receipt: { id: `fixture-receipt-${id}`, kind: 'submit',
      commit: head, tree, seat: agentId, frozenDigest: item.item_frozen_digest, sourceClean: true } }));
}

test('a seat with a green unreserved submission reviews it before any build, with no starvation wait [C7,#2992]', async t => {
  const box = await fixture(t);
  const review = box.add('Green submission waiting one minute'); box.submit(review);
  const build = box.add('Open build', { brief: 'Files: web/other.js\nTest: an independent build stays open.' });
  green(box, review);
  box.advance(60_000);
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.review, true, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, review);
  assert.equal(store.getItem(box.board, review).item_review_by, box.seats.actor.id);
  assert.equal(store.getItem(box.board, build).item_status, 'open', 'no build claim before the review');
});

test('the cross-family rule still decides who takes a green review [C7,#2992]', async t => {
  const box = await fixture(t, { family: 'require' });
  const review = box.add('Green submission from Family Alpha'); box.submit(review);
  const build = box.add('Open build', { brief: 'Files: web/other.js\nTest: an independent build stays open.' });
  green(box, review);
  const same = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(same.code, 0, same.out + same.err);
  assert.notEqual(same.document.review, true, 'a same-family seat is not given the review: ' + same.out);
  assert.equal(store.getItem(box.board, build).item_owner, box.seats.actor.id, 'the same-family seat builds instead');
  assert.equal(store.getItem(box.board, review).item_review_by, null);
  const other = await cli(box, box.seats.outside.path, ['next', '--take']);
  assert.equal(other.code, 0, other.out + other.err);
  assert.equal(other.document.review, true, other.out + other.err);
  assert.equal(other.document.item.item_id, review);
});

test('plain next also takes a one-minute green review before a build, below the ten-minute starvation wait [C7,#2992]', async t => {
  const box = await fixture(t);
  const review = box.add('Green submission below the starvation wait'); box.submit(review);
  const build = box.add('Open build', { brief: 'Files: web/other.js\nTest: an independent build stays open.' });
  green(box, review);
  box.advance(60_000);
  const taken = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.review, true, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, review);
  assert.equal(store.getItem(box.board, build).item_status, 'open', 'no build claim before the review');
});

test('a green submission whose earlier reservation expired or was released is reviewed before a build [C7,#2992]', async t => {
  const box = await fixture(t);
  const expired = box.add('Green submission whose review lease expired'); box.submit(expired);
  const released = box.add('Green submission whose reviewer released it'); box.submit(released);
  const build = box.add('Open build', { brief: 'Files: web/other.js\nTest: an independent build stays open.' });
  green(box, expired); green(box, released);
  store.reserveReview(box.board, expired, { agentId: box.seats.outside.id, lane: 'review', leaseMs: 60_000, policy: 'any' });
  // Past the 60 s lease but under the two-minute starvation age, so the green-review path, not the aged one, makes the offer.
  box.advance(61_000);
  assert.equal(store.reviewHolder(box.board, store.getItem(box.board, expired)), null, 'the earlier review lease has expired');
  store.reserveReview(box.board, released, { agentId: box.seats.outside.id, lane: 'review', leaseMs: 3_600_000, policy: 'any' });
  store.release(box.board, released, box.seats.outside.id, 'Fixture reviewer steps away.', undefined, 'OTHER');
  assert.equal(store.reviewHolder(box.board, store.getItem(box.board, released)), null, 'the reviewer released its reservation');
  const offer = store.reviewOffer(box.board, { agentId: box.seats.actor.id, lane: 'web', policy: 'any', mandatoryOnly: true });
  assert.equal(offer?.urgent, 'green-review', 'the mandatory green-review path offers work whose reservation is no longer live');
  const reviewed = [];
  for (const seat of [box.seats.actor, box.seats.sameFamily]) {
    const taken = await cli(box, seat.path, ['next', '--take']);
    assert.equal(taken.code, 0, taken.out + taken.err);
    assert.equal(taken.document.review, true, taken.out + taken.err);
    reviewed.push(taken.document.item.item_id);
  }
  assert.deepEqual(reviewed.sort(), [expired, released].sort(), 'each previously reserved green submission is offered again');
  assert.equal(store.getItem(box.board, build).item_status, 'open', 'no build claim before the waiting reviews');
});
