/** A runner that refuses a run at setup is an infrastructure stop, and the gate and landing share one rerun list [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INFRASTRUCTURE_CODES } from '../../index.js';
import { submitUntilSettled } from '../../index.js';
import { RERUNNABLE_RUNNER_REFUSALS } from '../../../../packages/store/index.js';
import { runnerFailureClass } from '../../../../packages/landing/index.js';
import { RunnerDropped } from '../../../../packages/gate/index.js';
import { Refused } from '../../../../packages/kernel/index.js';

const HOST = 'runner-9.example';
const refusal = code => Object.assign(new Refused(code, `runner ${HOST} refused this run before it started`), { lease: { runner: { host: HOST } } });

/** Run a hand-off whose first attempt fails with `error` (or every attempt when retries is 0), then collect what it decided. */
async function handoff(error, retries) {
  let runs = 0;
  const outcome = await submitUntilSettled(async () => {
    runs += 1;
    if (runs === 1 || retries === 0) throw error;
    return { green: true };
  }, { say: () => {}, healthy: async () => true, wait: async () => {}, retries });
  return { outcome, runs };
}

test('clause 1: a runner refusing at setup requeues the gate on another attempt and returns no red [C7]', async () => {
  const { outcome, runs } = await handoff(refusal('RUNNER_SETUP_REFUSED'));
  assert.equal(runs, 2);
  assert.equal(outcome.attempts[0].code, 'RUNNER_SETUP_REFUSED');
  assert.deepEqual(outcome.result, { green: true });
});

test('clause 1: when the retry budget is spent the stop is an infrastructure stop that keeps the claim and records no red [C7]', async () => {
  await assert.rejects(handoff(refusal('RUNNER_SETUP_REFUSED'), 0), error => {
    assert.equal(error.code, 'GATE_INFRA_EXHAUSTED');
    assert.match(error.message, /RUNNER_SETUP_REFUSED/u);
    assert.ok(INFRASTRUCTURE_CODES.has(error.code), 'the board holds this as a machine stop, not a builder red');
    return true;
  });
});

test('clause 2: the gate and landing classify every code in the shared rerun list the same way [C7]', () => {
  assert.ok(RERUNNABLE_RUNNER_REFUSALS.includes('RUNNER_SETUP_REFUSED'));
  for (const code of RERUNNABLE_RUNNER_REFUSALS) {
    assert.ok(INFRASTRUCTURE_CODES.has(code), `the gate treats ${code} as infrastructure`);
    assert.equal(runnerFailureClass(refusal(code), { RunnerDropped, Refused }).action, 'rerun', `landing reruns ${code}`);
  }
  assert.equal(runnerFailureClass(refusal('SOME_OTHER_REFUSAL'), { RunnerDropped, Refused }).action, 'fail');
  assert.equal(INFRASTRUCTURE_CODES.has('SOME_OTHER_REFUSAL'), false);
});
