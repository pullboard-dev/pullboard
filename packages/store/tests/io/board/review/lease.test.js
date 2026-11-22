/** @pullboard-test-input packages/store/src/io/board/review/lease.js packages/store/src/io/board.js */
/** The lapsed-reservation release carries a closed code at the board-release-codes engine and OTHER below it; the coordinator clears a held review reservation [C7,#12160,#12649]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clearReviewReservation } from '../../../../src/io/board/review/lease.js';
import { sweepLapsedReviews } from '../../../../src/io/board/review/lease.js';
import { reserveReview } from '../../../../src/io/board.js';
import { fixture } from '../../../fixtures/dispatch.js';
import { cellBoard } from '../../../fixtures/cell.js';

const MINUTE = 60_000;
/** An engine below the board-release-codes leaf (277). */
const OLDER_BOARD_VERSION = 276;

/** A submitted item whose reviewer holds a reservation, and the sweep over a lease the jobs cell reports as lapsed. */
function lapsed(t, engine) {
  const box = fixture(t, { boardOpener: cellBoard });
  const id = box.add('Item whose review lease lapses');
  box.submit(id);
  const reviewer = box.seats.reviewer?.id ?? 'reviewer-fixture';
  box.board.db.prepare('UPDATE item SET item_review_by=?, item_review_until=? WHERE item_id=?')
    .run(reviewer, new Date(box.clock.now().getTime() + 60 * MINUTE).toISOString(), id);
  box.board.enginePorts = { ...box.board.enginePorts, reviewLease: { reclaimLapsedReviews: () => [{ item: id, reviewer, lapsedMs: 5 * MINUTE }] } };
  const releases = () => box.board.db.prepare("SELECT event_detail FROM event WHERE item_id=? AND event_kind='release'").all(id).map(row => JSON.parse(row.event_detail));
  return { id, sweep: () => { if (engine !== undefined) box.board.executionEngineVersion = engine; return sweepLapsedReviews(box.board, new Map()); }, releases };
}

test('store.review-lease.lapsed-review-code: clause 1: at the board-release-codes engine the lapsed-reservation release carries REVIEW_LEASE_LAPSED with its prose reason unchanged [C7,#12160]', t => {
  const f = lapsed(t);
  assert.deepEqual(f.sweep(), [f.id]);
  const [release] = f.releases();
  assert.equal(release.reasonCode, 'REVIEW_LEASE_LAPSED');
  assert.match(release.reason, /^Review silent for \d+ minutes; its reservation lease lapsed\.$/);
});

test('store.review-lease.lapsed-review-code-below-engine: clause 1: below the board-release-codes engine the lapsed-reservation release still carries OTHER with the same prose [C7,#12160]', t => {
  const f = lapsed(t, OLDER_BOARD_VERSION);
  assert.deepEqual(f.sweep(), [f.id]);
  const [release] = f.releases();
  assert.equal(release.reasonCode, 'OTHER');
  assert.match(release.reason, /^Review silent for \d+ minutes; its reservation lease lapsed\.$/);
});

const HOUR = 60 * MINUTE;

/** A submitted item reserved for review by the sibling seat, with an in-memory review-lease port that records what ends. */
function held(t) {
  const box = fixture(t, { boardOpener: cellBoard });
  const id = box.add('Item whose review reservation the coordinator clears');
  box.submit(id);
  const holders = new Map();
  const ended = [];
  box.board.enginePorts = { ...box.board.enginePorts, reviewLease: {
    reserveReview: (db, item, reviewer) => { const holder = holders.get(item); if (holder && holder !== reviewer) return { reserved: false, holder }; holders.set(item, reviewer); return { reserved: true, holder: reviewer }; },
    renewReview: (db, item, reviewer) => holders.get(item) === reviewer,
    reclaimLapsedReviews: () => [],
    releaseReview: (db, item) => { ended.push(item); const holder = holders.get(item) ?? null; holders.delete(item); return holder; },
  } };
  const reserve = seat => reserveReview(box.board, id, { agentId: seat.id, lane: seat.lane, leaseMs: HOUR, policy: 'any' });
  reserve(box.seats.sibling);
  const row = () => box.board.db.prepare('SELECT item_status, item_review_by, item_review_until, item_reservation_holder FROM item WHERE item_id=?').get(id);
  const events = () => box.board.db.prepare("SELECT event_kind FROM event WHERE item_id=? AND event_kind IN ('clear_review_reservation','release') ORDER BY event_id").all(id).map(event => event.event_kind);
  return { box, id, holders, ended, reserve, row, events };
}

test('store.review-lease.coordinator-clear: clause 1: the coordinator clearReviewReservation clears only the submitted item review reservation, ends its review lease, leaves it submitted and lets another reviewer reserve it [C7,#12649]', t => {
  const f = held(t);
  f.box.board.db.prepare('UPDATE item SET item_reservation_holder=? WHERE item_id=?').run('web-build-seat', f.id);
  assert.equal(f.row().item_review_by, f.box.seats.sibling.id);
  assert.equal(f.holders.get(f.id), f.box.seats.sibling.id);
  const cleared = clearReviewReservation(f.box.board, f.id, { agentId: 'coordinator' });
  assert.equal(cleared.holder, f.box.seats.sibling.id);
  const after = f.row();
  assert.equal(after.item_status, 'submitted');
  assert.equal(after.item_review_by, null);
  assert.equal(after.item_review_until, null);
  assert.equal(after.item_reservation_holder, 'web-build-seat', 'the build-route reservation is untouched');
  assert.deepEqual(f.ended, [f.id], 'the review-job lease ended through the review lease port');
  assert.equal(f.holders.has(f.id), false);
  assert.deepEqual(f.events(), ['clear_review_reservation'], 'the clear is its own event, not a reviewer release');
  f.reserve(f.box.seats.outside);
  assert.equal(f.row().item_review_by, f.box.seats.outside.id, 'another reviewer reserves the cleared review');
  assert.equal(f.holders.get(f.id), f.box.seats.outside.id);
});

test('store.review-lease.coordinator-clear-refusals: clause 2: a non-coordinator clearReviewReservation is refused with no mutation, a build-route reservation alone is not cleared, and an item with no review reservation is refused [C7,#12649]', t => {
  const f = held(t);
  const before = f.row();
  const board = f.box.board;
  const mutated = () => ({ row: f.row(), ended: [...f.ended], holders: [...f.holders], events: f.events() });
  const untouched = mutated();
  assert.throws(() => clearReviewReservation(board, f.id, { agentId: f.box.seats.actor.id }), { code: 'COORDINATOR_ONLY' });
  assert.deepEqual(mutated(), untouched);
  assert.deepEqual(f.row(), before);
  const other = held(t);
  other.box.board.db.prepare('UPDATE item SET item_review_by=NULL, item_review_until=NULL, item_reservation_holder=? WHERE item_id=?').run('web-build-seat', other.id);
  const build = other.row();
  assert.throws(() => clearReviewReservation(other.box.board, other.id, { agentId: 'coordinator' }), { code: 'USAGE' });
  assert.deepEqual(other.row(), build, 'a build-route reservation is not a review reservation and stays');
  assert.deepEqual(other.ended, []);
  assert.deepEqual(other.events(), []);
});
