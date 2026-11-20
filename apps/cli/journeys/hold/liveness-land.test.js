/** A kill or a cut link on the lander at the land step finishes or reopens the item within three fake minutes, with no person acting [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIVENESS_BOUND_MS,
  runLivenessFlow,
} from './liveness-kit.js';

test('cli.journeys-hold-liveness-land.a-kill-at-the-land-step: clause 1: a kill at the land step finishes or reopens the item within 3 fake minutes, no person or coordinator acts [C7]', async t => {
  const result = await runLivenessFlow(t, { step: 'land', fault: 'kill', seed: 17 });
  assert.ok(result.elapsedMs <= LIVENESS_BOUND_MS, `the board took ${result.elapsedMs} ms (state "${result.state}", last recovery ${result.recovery}), past the ${LIVENESS_BOUND_MS} ms bound`);
});

test('cli.journeys-hold-liveness-land.a-cut-at-the-land-step: clause 1: a cut at the land step finishes or reopens the item within 3 fake minutes, no person or coordinator acts [C7]', async t => {
  const result = await runLivenessFlow(t, { step: 'land', fault: 'cut', seed: 17 });
  assert.ok(result.elapsedMs <= LIVENESS_BOUND_MS, `the board took ${result.elapsedMs} ms (state "${result.state}", last recovery ${result.recovery}), past the ${LIVENESS_BOUND_MS} ms bound`);
});
