/** A reviewer is not re-offered a review it dropped for family or size, and may be re-offered one dropped for infrastructure after the cooldown [C7,#8922]. */
// fixture-subject: addItem (a store unit test of next --verify over one submitted item; the board is the shared fixture board)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { board as store } from '../../../lib/index.js';
import { TESTKIT_MODEL } from '../../tests/fixtures/testkit.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';

const LEASE = 3_600_000;
const HOUR = 3_600_000;
const freeze = () => ({ text: '{}', digest: 'synthetic-review-reason-next-bar' });

/** A board with a movable clock, a builder, one reviewer and one submitted item the reviewer holds; the reviewer releases it with this reason code. */
function released(t, code) {
  let now = Date.parse('2026-11-16T12:00:00Z');
  const board = fixtureBoard(t, { clock: { now: () => new Date(now) } });
  for (const [id, family, digit] of [['coordinator', 'human', 'e'], ['core-1', 'codex', 'a'], ['core-2', 'claude', 'b']]) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, family,
      parentDigest: digit.repeat(64), sessionDigest: digit.repeat(64), model: TESTKIT_MODEL });
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review reason next fixture' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: LEASE, freeze });
  submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  store.reserveReview(board, id, { agentId: 'core-2', leaseMs: LEASE, policy: 'any' });
  assert.equal(store.release(board, id, 'core-2', 'Dropped the review for a stated reason.', undefined, code), true);
  return { board, id, later: ms => { now += ms; } };
}

/** The item next --verify offers the reviewer, or null. */
const offered = (board, agentId = 'core-2') => store.nextFor(board, { agentId, lane: 'core', verify: true }).item?.item_id ?? null;

test('clause 1: after a review is released with reason family or too large, next --verify never offers it to that reviewer again [C7,#8922]', t => {
  for (const code of ['FAMILY', 'TOO_LARGE']) {
    const { board, id, later } = released(t, code);
    assert.notEqual(offered(board), id, `${code}: not offered at once`);
    later(30 * 24 * HOUR);
    assert.notEqual(offered(board), id, `${code}: not offered after a month either`);
    assert.ok(store.reviewReleaseCooldown(board, id, 'core-2'), `${code}: the cooldown is still set`);
  }
});

test('clause 2: after reason infra, the same reviewer is offered the review again once the release cooldown has passed [C7,#8922]', t => {
  const { board, id, later } = released(t, 'INFRA');
  assert.notEqual(offered(board), id, 'not offered inside the cooldown');
  later(2 * HOUR);
  assert.equal(offered(board), id, 'offered again after the cooldown');
});
