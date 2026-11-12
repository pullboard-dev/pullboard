/** A kill or a cut link at the submit step reopens or finishes the item within three fake minutes, with no person acting [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FAULTS,
  LIVENESS_BOUND_MS,
  runLivenessFlow,
} from './liveness-kit.js';

for (const fault of FAULTS) {
  test(`clause 1: a ${fault} at the submit step reopens or finishes the item within 3 fake minutes, no person or coordinator acts [C7]`, async t => {
    const result = await runLivenessFlow(t, { step: 'submit', fault, seed: 11 });
    assert.notEqual(result.state, 'claimed', `the item stayed claimed by ${result.owner} after ${result.elapsedMs} ms`);
    assert.equal(result.owner, null, 'the dead holder no longer owns the item');
    assert.ok(result.elapsedMs <= LIVENESS_BOUND_MS, `the board took ${result.elapsedMs} ms, past the ${LIVENESS_BOUND_MS} ms bound`);
  });
}
