/** A dropped review records its reason (bar, family, infra or too large) as a recorded move, behind review.releaseReasons [C7,H16,#8920]. */
// fixture-subject: addItem (a store unit test of the release move over one submitted item; the board is the shared fixture board)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { store } from '../../../fixtures/board.js';
import { TESTKIT_MODEL } from '../../../fixtures/testkit.js';
import { fixtureBoard } from '../../../fixtures/board.js';
import { submitFixture } from '../../../fixtures/board/submit.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { reviewReleaseReasonsRequired } from '../../../../../../packages/config/index.js';
import { REVIEW_RELEASE_REASONS } from '../../../../../../packages/store/index.js';
import { releaseReasonProblem } from '../../../../../../packages/store/index.js';
import { REVIEW_RELEASE_REASON_ENGINE } from '../../../../../../packages/state/light.js';
import { release as releaseMove } from '../../../../../../packages/moves/index.js';

const LEASE = 3_600_000;
const freeze = () => ({ text: '{}', digest: 'synthetic-review-reason-bar' });

/** A board with a coordinator, a builder and a reviewer, and one submitted item whose review the reviewer holds. */
function reviewed(t) {
  const board = fixtureBoard(t);
  for (const [id, family, digit] of [['coordinator', 'human', 'e'], ['core-1', 'codex', 'a'], ['core-2', 'claude', 'b']]) {
    store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`, family,
      parentDigest: digit.repeat(64), sessionDigest: digit.repeat(64), model: TESTKIT_MODEL });
  }
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Review reason fixture' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: LEASE, freeze });
  submitFixture(board, id, { agentId: 'core-1', commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  store.reserveReview(board, id, { agentId: 'core-2', leaseMs: LEASE, policy: 'any' });
  return { board, id };
}

test('cli.journeys-release-review-reason.releasing-a-review-with-reason-bar: clause 1: releasing a review with --reason bar, family, infra or too large records that reason on the release [C7,#8920]', t => {
  for (const code of REVIEW_RELEASE_REASONS) {
    const { board, id } = reviewed(t);
    assert.equal(store.release(board, id, 'core-2', 'Dropped the review for a stated reason.', undefined, code), true);
    const event = store.events(board, { itemId: id }).findLast(entry => entry.event_kind === 'release');
    assert.equal(JSON.parse(event.event_detail).reasonCode, code, `${code} is recorded on the release`);
    assert.equal(store.getItem(board, id).item_review_by, null, 'the review is free again');
  }
});

test('cli.journeys-release-review-reason.a-review-only-reason-on-a: clause 1: a review-only reason on a build release is refused, and the build reasons are unchanged [C7,#8920]', t => {
  const board = fixtureBoard(t);
  store.register(board, { id: 'coordinator', lane: 'coordinator', path: '/fixture/coordinator', family: 'human', parentDigest: 'e'.repeat(64), sessionDigest: 'e'.repeat(64), model: TESTKIT_MODEL });
  store.register(board, { id: 'core-1', lane: 'core', path: '/fixture/core-1', family: 'codex', parentDigest: 'a'.repeat(64), sessionDigest: 'a'.repeat(64), model: TESTKIT_MODEL });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Build release fixture' });
  store.claim(board, id, { agentId: 'core-1', lane: 'core', leaseMs: LEASE, freeze });
  assert.throws(() => store.release(board, id, 'core-1', 'not a review', undefined, 'BAR'), { code: 'RELEASE_REASON' });
  assert.equal(store.release(board, id, 'core-1', 'budget', undefined, 'BUDGET'), false);
});

test('cli.journeys-release-review-reason.the-move-carries-an-engine-marker: clause 2: the move carries an engine marker, and a board replayed below it reads as before [C7,H16,#8920]', t => {
  const { board, id } = reviewed(t);
  const minimum = code => releaseMove.minimumEngine([id, 'core-2', 'why', undefined, code], board, undefined);
  assert.equal(minimum('BAR'), REVIEW_RELEASE_REASON_ENGINE);
  assert.equal(minimum('TOO_LARGE'), REVIEW_RELEASE_REASON_ENGINE);
  assert.ok(minimum('OTHER') < REVIEW_RELEASE_REASON_ENGINE, 'the older codes keep their older engines');
  const below = REVIEW_RELEASE_REASON_ENGINE - 1;
  assert.equal(releaseReasonProblem('BAR', 'why', below)?.code, 'ENGINE_VERSION');
  assert.equal(releaseReasonProblem('OTHER', 'why', below), null, 'a board replayed below the marker reads as before');
  assert.equal(releaseReasonProblem('BAR', 'why', REVIEW_RELEASE_REASON_ENGINE), null);
});

test('cli.journeys-release-review-reason.review-releasereasons-is-off-on-an: clause 1: review.releaseReasons is off on an empty machine home, so a review release is unchanged [C7,#8920]', () => {
  const home = privateFixtureFiles('pullboard-review-reasons-').root;
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { assert.equal(reviewReleaseReasonsRequired(), false); }
  finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
});
