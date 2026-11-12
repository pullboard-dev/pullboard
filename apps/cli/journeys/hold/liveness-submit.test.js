/** A kill or a cut link after submit leaves the item finished or reopened within three fake minutes, with no person acting [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FAULTS,
  LIVENESS_BOUND_MS,
  runLivenessFlow,
} from './liveness-kit.js';

for (const fault of FAULTS) {
  test(`clause 1: a ${fault} at the submit step finishes or reopens the item within 3 fake minutes, no person or coordinator acts [C7]`, async t => {
    const result = await runLivenessFlow(t, { step: 'submit', fault, seed: 11 });
    // Finished: the submitted commit no longer depends on its holder, so the item waits for a verifier. Reopened: it is open with no owner.
    assert.ok(['submitted', 'open'].includes(result.state), `the item sat in "${result.state}" owned by ${result.owner} after ${result.elapsedMs} ms`);
    assert.ok(result.elapsedMs <= LIVENESS_BOUND_MS, `the board took ${result.elapsedMs} ms, past the ${LIVENESS_BOUND_MS} ms bound`);
  });
}
