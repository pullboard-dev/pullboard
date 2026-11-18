/** show's review lines come from one pure function, with the exact text the full path printed before [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewLines } from '../../../src/logic/show/review.js';

test('cli.logic-show-review.review-lines-match-the-recorded-text: clause 1: reviewLines returns the machine-verified, review tier, eligible reviewers and builder parent lines exactly as show printed them for a ready and a not-submitted item, a known and an unknown builder parent [C7]', () => {
  const ready = reviewLines(true, { tier: 'standard', ready: true, eligible: ['core-1', 'core-2'], authorParents: [{ parent: 'sess-9', seats: ['core-3'] }, { parent: 'unknown', seats: ['core-4', 'core-5'] }] });
  assert.deepEqual(ready, {
    machine: 'machine-verified: on (frozen commands; strict and sensitive changes require review)',
    tier: 'review tier: standard',
    eligible: 'eligible reviewers: core-1, core-2',
    parents: ['builder parent session sess-9 (core-3): seats under this parent are not offered the review', 'builder parent session: unknown (core-4, core-5); no seat is excluded by parent'],
  });
  const waiting = reviewLines(false, { tier: 'strong', requiredFamily: 'openai', ready: false });
  assert.deepEqual(waiting, { machine: 'machine-verified: off', tier: 'review tier: strong; required family openai', eligible: 'eligible reviewers: not submitted', parents: [] });
  assert.equal(reviewLines(false, { tier: 'standard', ready: true, eligible: [] }).eligible, 'eligible reviewers: none', 'ready with nobody eligible prints none');
});
