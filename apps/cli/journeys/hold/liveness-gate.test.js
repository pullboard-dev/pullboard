/** A kill or a cut link on a gate runner at the gate step finishes or reopens the item within three fake minutes, with no person acting [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FAULTS,
  LIVENESS_BOUND_MS,
  runLivenessFlow,
} from './liveness-kit.js';

for (const fault of FAULTS) {
  test(`clause 1: a ${fault} at the gate step finishes or reopens the item within 3 fake minutes, no person or coordinator acts [C7]`, async t => {
    const result = await runLivenessFlow(t, { step: 'gate', fault, seed: 13 });
    assert.ok(result.elapsedMs <= LIVENESS_BOUND_MS, `the board took ${result.elapsedMs} ms (state "${result.state}", last recovery ${result.recovery}), past the ${LIVENESS_BOUND_MS} ms bound`);
  });
}
