/** A family that released a review twice is refused it again behind board.holdAfterTwoReleases, from REVIEW_RELEASE_TWICE_ENGINE on [C7,#10932]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../index.js';
import { fixtureBoard } from '../../../../../board/tests/fixtures/board.js';
import { heartbeatSeat } from '../../../../index.js';
import { REVIEW_RELEASE_TWICE_ENGINE } from '../../../../../state/light.js';
import { RELEASE_UNTOUCHED_REROUTE_ENGINE } from '../../../../../state/light.js';

// The release table decides review releases from the untouched-reroute engine on; the hold rule needs both.
const TABLE_STARTS_AT = Math.max(REVIEW_RELEASE_TWICE_ENGINE, RELEASE_UNTOUCHED_REROUTE_ENGINE);

// fixture-subject: addItem (a store unit test of review reservations over a hand-built submitted item)
const SYNTHETIC_MODEL = 'Synthetic fixture model';
const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40);
const freeze = () => ({ text: '{}', digest: 'synthetic-reserve-review-bar' });
const REVIEW = { policy: 'any', familyPolicy: 'off' };

/** A submitted item built by core-1 (openai) that core-2 and core-3 (openai) release in review, with core-4 (claude) free to review; the coordinator's hold is lifted. */
function fixture(t, { flag, engine = TABLE_STARTS_AT }) {
  const board = fixtureBoard(t);
  board.holdAfterTwoReleases = flag;
  board.executionEngineVersion = engine;
  const seats = [['coordinator', 'coordinator', undefined, 'f'], ['core-1', 'core', 'openai', 'a'], ['core-2', 'core', 'openai', 'b'], ['core-3', 'core', 'openai', 'c'], ['core-4', 'core', 'claude', 'd'], ['core-5', 'core', 'openai', 'e']];
  for (const [id, lane, family, parent] of seats) {
    store.register(board, { id, lane, path: `/fixture/${id}`, family, parentDigest: parent.repeat(64), session: parent.repeat(64), model: SYNTHETIC_MODEL });
    heartbeatSeat(board, id);
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Reserve review fixture' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: 3_600_000, freeze });
  store.submit(board, id, { agentId: 'core-1', commit: COMMIT, tree: TREE, files: [],
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic native board-state fixture; no execution proof' } });
  for (const seat of ['core-2', 'core-3']) {
    store.reserveReview(board, id, { agentId: seat, leaseMs: 60_000, ...REVIEW });
    store.release(board, id, seat, 'no time to judge this one', 'OTHER');
  }
  if (store.getItem(board, id).item_hold_by) store.releaseItemHold(board, id, { agentId: 'coordinator' });
  return { board, id, events: () => board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n };
}

test('store.io-board-reserve-review.same-family-refused: clause 1: with board.holdAfterTwoReleases on at REVIEW_RELEASE_TWICE_ENGINE, reserveReview refuses a seat of the family that released the review twice REVIEW_RELEASE_TWICE, names another family or the coordinator, and writes nothing [C7,#10932]', t => {
  const f = fixture(t, { flag: true });
  const before = f.events();
  // core-5 is openai and never released this review itself, so only the family's two releases refuse it.
  assert.throws(() => store.reserveReview(f.board, f.id, { agentId: 'core-5', leaseMs: 60_000, ...REVIEW }), error => {
    assert.equal(error.code, 'REVIEW_RELEASE_TWICE');
    assert.match(error.message, /another model family.*coordinator/u);
    return true;
  });
  assert.equal(f.events(), before, 'a refused reservation writes no event');
  assert.equal(store.getItem(f.board, f.id).item_review_by, null, 'and holds no lease');
});

test('store.io-board-reserve-review.other-family-and-off: clause 2: a seat of another family reserves that review, and with board.holdAfterTwoReleases off a seat of the releasing family reserves it as on main [C7,#10932]', t => {
  const other = fixture(t, { flag: true });
  assert.equal(store.reserveReview(other.board, other.id, { agentId: 'core-4', leaseMs: 60_000, ...REVIEW }).item_review_by, 'core-4');
  for (const given of [{ flag: false }, { flag: undefined }, { flag: true, engine: REVIEW_RELEASE_TWICE_ENGINE - 1 }]) {
    const f = fixture(t, given);
    assert.equal(store.reserveReview(f.board, f.id, { agentId: 'core-5', leaseMs: 60_000, ...REVIEW }).item_review_by, 'core-5', JSON.stringify(given));
  }
});
