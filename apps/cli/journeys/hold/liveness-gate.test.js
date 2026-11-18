/** A kill or a cut link on a gate runner at the gate step finishes or reopens the item within three fake minutes, with no person acting [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIVENESS_BOUND_MS,
  runLivenessFlow,
} from './liveness-kit.js';

test('cli.journeys-hold-liveness-gate.a-kill-at-the-gate-step: clause 1: a kill at the gate step finishes or reopens the item within 3 fake minutes, no person or coordinator acts [C7]', async t => {
  const result = await runLivenessFlow(t, { step: 'gate', fault: 'kill', seed: 13 });
  assert.ok(result.elapsedMs <= LIVENESS_BOUND_MS, `the board took ${result.elapsedMs} ms (state "${result.state}", last recovery ${result.recovery}), past the ${LIVENESS_BOUND_MS} ms bound`);
});

test('cli.journeys-hold-liveness-gate.a-cut-at-the-gate-step: clause 1: a cut at the gate step finishes or reopens the item within 3 fake minutes, no person or coordinator acts [C7]', async t => {
  const result = await runLivenessFlow(t, { step: 'gate', fault: 'cut', seed: 13 });
  assert.ok(result.elapsedMs <= LIVENESS_BOUND_MS, `the board took ${result.elapsedMs} ms (state "${result.state}", last recovery ${result.recovery}), past the ${LIVENESS_BOUND_MS} ms bound`);
});
