/** A kill or a cut link on the builder at the submit step finishes or reopens the item within three fake minutes, with no person acting [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LIVENESS_BOUND_MS,
  runLivenessFlow,
} from './liveness-kit.js';

test('cli.journeys-hold-liveness-submit.a-kill-at-the-submit-step: clause 1: a kill at the submit step finishes or reopens the item within 3 fake minutes, no person or coordinator acts [C7]', async t => {
  const result = await runLivenessFlow(t, { step: 'submit', fault: 'kill', seed: 11 });
  // Finished: the submitted commit no longer depends on its holder, so the item waits for a verifier. Reopened: it is open with no owner.
  assert.ok(['submitted', 'open'].includes(result.state), `the item sat in "${result.state}" owned by ${result.owner} after ${result.elapsedMs} ms`);
  assert.ok(result.elapsedMs <= LIVENESS_BOUND_MS, `the board took ${result.elapsedMs} ms (state "${result.state}", last recovery ${result.recovery}), past the ${LIVENESS_BOUND_MS} ms bound`);
});

test('cli.journeys-hold-liveness-submit.a-cut-at-the-submit-step: clause 1: a cut at the submit step finishes or reopens the item within 3 fake minutes, no person or coordinator acts [C7]', async t => {
  const result = await runLivenessFlow(t, { step: 'submit', fault: 'cut', seed: 11 });
  // Finished: the submitted commit no longer depends on its holder, so the item waits for a verifier. Reopened: it is open with no owner.
  assert.ok(['submitted', 'open'].includes(result.state), `the item sat in "${result.state}" owned by ${result.owner} after ${result.elapsedMs} ms`);
  assert.ok(result.elapsedMs <= LIVENESS_BOUND_MS, `the board took ${result.elapsedMs} ms (state "${result.state}", last recovery ${result.recovery}), past the ${LIVENESS_BOUND_MS} ms bound`);
});
