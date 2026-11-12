/** The liveness chaos kit breaks a holder at a named step and reads what the board did alone [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FAULTS,
  LIVENESS_BOUND_MS,
  runLivenessFlow,
} from './liveness-kit.js';

test('clause 1: the kit runs one flow, breaks a holder at a named step and returns the final item state and elapsed fake time [C7]', async t => {
  const result = await runLivenessFlow(t, { step: 'claim', fault: 'cut', seed: 7 });
  assert.equal(result.step, 'claim');
  assert.equal(result.fault, 'cut');
  assert.equal(typeof result.state, 'string');
  assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs > 0, 'the elapsed time is read off the fake clock');
  assert.deepEqual([...FAULTS], ['kill', 'cut']);
  await assert.rejects(() => runLivenessFlow(t, { step: 'nowhere' }), error => error.code === 'LIVENESS_STEP');
});

for (const fault of FAULTS) {
  test(`clause 2: a ${fault} at the step 'claim' ends with the item reopened or finished within 3 fake minutes, no person action [C7]`, async t => {
    const result = await runLivenessFlow(t, { step: 'claim', fault });
    assert.notEqual(result.state, 'claimed', `the item stayed claimed by ${result.owner} after ${result.elapsedMs} ms`);
    assert.equal(result.owner, null, 'the dead holder no longer owns the item');
    assert.ok(result.elapsedMs <= LIVENESS_BOUND_MS, `the board took ${result.elapsedMs} ms, past the ${LIVENESS_BOUND_MS} ms bound`);
  });
}
