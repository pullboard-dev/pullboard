/** @pullboard-test-input packages/store/src/io/board/review/lease.js */
/** The lapsed-reservation release carries a closed code at the board-release-codes engine and OTHER below it [C7,#12160]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sweepLapsedReviews } from '../../../../src/io/board/review/lease.js';
import { fixture } from '../../../fixtures/dispatch.js';

const MINUTE = 60_000;
/** An engine below the board-release-codes leaf (277). */
const OLDER_BOARD_VERSION = 276;

/** A submitted item whose reviewer holds a reservation, and the sweep over a lease the jobs cell reports as lapsed. */
function lapsed(t, engine) {
  const box = fixture(t);
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
