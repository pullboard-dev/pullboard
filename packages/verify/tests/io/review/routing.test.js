/** A review dropped for family or size stays out of the same reviewer's offers until resubmit; a bar or infra drop keeps the timed cooldown [C7,V1,R1,#2994]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REVIEW_RELEASE_REASON_ENGINE } from '../../../../state/light.js';
import { reviewReleaseCooldown } from '../../../index.js';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const COOLDOWN_MS = 30 * 60_000;

/** A board at an engine number, and a reader that finds one release coded as given, made ten minutes before now. */
function released(code, engineVersion = REVIEW_RELEASE_REASON_ENGINE) {
  const board = { executionEngineVersion: engineVersion, clock: { now: () => new Date(NOW) } };
  const reviewReleasesSinceSubmit = () => [{ code, event_at: new Date(NOW - 10 * 60_000).toISOString(), legacy: false }];
  return { board, options: { engineVersion, reviewReleasesSinceSubmit, cooldownMs: COOLDOWN_MS } };
}

test('verify.io-review-routing.family-and-size-wait-for-resubmit: clause 2: a review released as FAMILY or TOO_LARGE is not offered to the same reviewer again until the item is resubmitted [C7,V1,R1]', () => {
  for (const code of ['FAMILY', 'TOO_LARGE']) {
    const { board, options } = released(code);
    assert.equal(reviewReleaseCooldown(board, 7, 'reviewer-1', options), 'a new submission', code);
  }
});

test('verify.io-review-routing.bar-and-infra-keep-the-timed-cooldown: clause 2: a review released as BAR or INFRA keeps the timed cooldown and ends after it [C7,V1,R1]', () => {
  for (const code of ['BAR', 'INFRA']) {
    const { board, options } = released(code);
    assert.equal(reviewReleaseCooldown(board, 7, 'reviewer-1', options), new Date(NOW + 20 * 60_000).toISOString(), code);
    board.clock.now = () => new Date(NOW + 21 * 60_000);
    assert.equal(reviewReleaseCooldown(board, 7, 'reviewer-1', options), null, `${code} past its cooldown`);
  }
});

test('verify.io-review-routing.old-engine-keeps-the-timed-cooldown: clause 2: below the review-reason engine a FAMILY release keeps the timed cooldown [C7,V1,R1]', () => {
  const { board, options } = released('FAMILY', REVIEW_RELEASE_REASON_ENGINE - 1);
  assert.equal(reviewReleaseCooldown(board, 7, 'reviewer-1', options), new Date(NOW + 20 * 60_000).toISOString());
});
