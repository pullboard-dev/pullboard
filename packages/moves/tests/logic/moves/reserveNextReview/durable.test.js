/** Durable gate 24/20: review reservations are leases in the jobs cell and lapse on the 2-minute rule [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { closeCellBoard } from '../../../../../board/tests/fixtures/cell-board.js';
import { openCellBoard } from '../../../../../board/tests/fixtures/cell-board.js';
import { LEASE_MS } from '../../../../../jobs/index.js';
import { jobView } from '../../../../../jobs/index.js';
import { reclaimLapsedReviews } from '../../../../../jobs/index.js';
import { renewReview } from '../../../../../jobs/index.js';
import { reserveReview } from '../../../../../jobs/index.js';
import { reviewOffer } from '../../../../../jobs/index.js';
import * as store from '../../../../../store/index.js';
import { fixture } from '../../../fixtures/next.js';
import { next } from '../../../fixtures/next.js';
import { cellBoard } from '../../../../../board/tests/fixtures/cell-board.js';

const files = privateFixtureFiles('pullboard-durable-review-');
after(() => rmSync(files.root, { recursive: true, force: true }));

/** Open a fresh real board file and hand its SQLite handle to the body. */
function withBoard(name, body) {
  const board = openCellBoard(join(files.root, `${name}.sqlite`));
  try { return body(board.db); } finally { closeCellBoard(board); }
}

test('moves.reserve-next-review-durable.a-silent-reviewer-loses-the-reservation-within: clause 1: a silent reviewer loses the reservation within 2 minutes, the item is offered again and the lapse is recorded [C7]', () => {
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

test('moves.reserve-next-review-durable.a-reviewer-that-keeps-renewing-keeps-the: clause 1: a reviewer that keeps renewing keeps the reservation and nothing is reclaimed [C7]', () => {
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

/** Register a review seat with its own worktree and parent, and record its first heartbeat. */
function reviewSeat(box, name) {
  const path = join(box.project.dir, `durable-review-${name}`);
  mkdirSync(path);
  const id = store.register(box.board, { lane: 'review', path, parent: `durable-review-${name}`, family: 'Family Beta', route: 'strong' });
  store.heartbeatSeat(box.board, id);
  return { id, lane: 'review', path };
}

test('moves.reserve-next-review-durable.next-verify-holds-the-review-as-a: clause 1: next --verify holds the review as a jobs-cell lease and reclaims a silent reviewer after 2 minutes with the lapse recorded [C7]', async t => {
  const box = fixture(t, { boardFrom: cellBoard, reviewers: true });
  const id = box.add('Review whose reviewer goes silent');
  box.submit(id);
  const silent = reviewSeat(box, 'silent');
  const successor = reviewSeat(box, 'successor');
  box.as(silent);
  await next(box, { verify: true, verifyId: String(id) });
  const lease = jobView(box.board.db, `review:${id}`);
  assert.equal(lease.kind, 'review');
  assert.equal(lease.leaseOwner, silent.id, 'the reservation is a lease in the jobs cell');

  box.advance(LEASE_MS + 1);
  box.as(successor);
  const reclaimed = await next(box, { verify: true });
  assert.equal(reclaimed.item.item_id, id, 'the item is offered again');
  assert.equal(store.getItem(box.board, id).item_review_by, successor.id);
  const steps = jobView(box.board.db, `review:${id}`).steps;
  assert.deepEqual(steps.map(step => step.name), ['reserved', 'lapsed', 'reserved']);
  assert.equal(steps[1].payload.reviewer, silent.id, 'the lapse names the silent reviewer');
  const release = box.board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='release' ORDER BY event_id DESC LIMIT 1").get(id);
  assert.equal(JSON.parse(release.event_detail).lapsed.reviewer, silent.id, 'the board records the lapse as a review release');
});

/** A submitted item reserved by the sibling reviewer through next --verify, with its live review job. */
async function reservedOnBoard(t) {
  const box = fixture(t, { boardFrom: cellBoard, reviewers: true });
  const id = box.add('Review whose item moves on');
  box.submit(id);
  box.as('sibling');
  await next(box, { verify: true, verifyId: String(id) });
  assert.equal(jobView(box.board.db, `review:${id}`).leaseOwner, box.seats.sibling.id);
  return { box, id };
}

/** Assert the item's review job was released by its reviewer and is done. */
function assertEnded(box, id) {
  const job = jobView(box.board.db, `review:${id}`);
  assert.deepEqual([job.step, job.leaseOwner, job.leaseUntil], ['done', null, 0]);
  assert.deepEqual(job.steps.map(step => [step.name, step.payload.reviewer]), [['reserved', box.seats.sibling.id], ['released', box.seats.sibling.id]]);
}

test('moves.reserve-next-review-durable.sm5-withdraw-releases-the-item-s-review-job: SM5: withdraw releases the item\'s review job in its own transaction [C7]', async t => {
  const { box, id } = await reservedOnBoard(t);
  assert.throws(() => store.withdraw(box.board, id, { agentId: 'coordinator', reason: ' ' }), error => error.code === 'NOTE_REQUIRED');
  assert.equal(jobView(box.board.db, `review:${id}`).leaseOwner, box.seats.sibling.id, 'a refused withdrawal leaves the job alone');
  store.withdraw(box.board, id, { agentId: 'coordinator', reason: 'duplicate' });
  assertEnded(box, id);
});

test('moves.reserve-next-review-durable.sm5-reopen-releases-the-item-s-review-job: SM5: reopen releases the item\'s review job in its own transaction [C7]', async t => {
  const { box, id } = await reservedOnBoard(t);
  assert.throws(() => store.reopen(box.board, id, { agentId: 'coordinator', note: '' }), error => error.code === 'NOTE_REQUIRED');
  assert.equal(jobView(box.board.db, `review:${id}`).leaseOwner, box.seats.sibling.id, 'a refused reopen leaves the job alone');
  store.reopen(box.board, id, { agentId: 'coordinator', note: 'the criterion needs correction' });
  assertEnded(box, id);
});

test('moves.reserve-next-review-durable.sm5-a-verdict-releases-the-item-s-review: SM5: a verdict releases the item\'s review job in its own transaction [C7]', async t => {
  const { box, id } = await reservedOnBoard(t);
  const item = store.getItem(box.board, id);
  const verdict = { agentId: box.seats.sibling.id, decision: 'REJECT', reason: 'TEST_FAILURE', clause: 'The real fixture succeeds.', head: item.item_commit, digest: item.item_frozen_digest, policy: 'any' };
  assert.throws(() => store.verify(box.board, id, { ...verdict, note: '' }), error => error.code === 'NOTE_REQUIRED');
  assert.equal(jobView(box.board.db, `review:${id}`).leaseOwner, box.seats.sibling.id, 'a refused verdict leaves the job alone');
  store.verify(box.board, id, { ...verdict, note: 'the fixture fails' });
  assertEnded(box, id);
});
