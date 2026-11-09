/** The add check baseline runs on a runner and never on the coordinator machine [C7,V2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measureBaseline } from '../packages/gate/src/shell/check-baseline-worker.js';

const EXPECTED = { command: 'node bin/run-tests.js test/a.test.js', main: 'a'.repeat(40) };

test('clause 2: with no runner registered the baseline is pending, never run on this machine [C7,V2]', async () => {
  // No execution services at all: nothing may run locally.
  assert.equal(await measureBaseline('/nonexistent-root', 1, EXPECTED, {}), null);
  // Services whose runner list is empty: still nothing runs locally.
  let touched = 0;
  const services = { gateExecutionServices: async () => ({ runners: { effectiveRunners: () => { touched += 1; return []; } }, landing: {} }) };
  assert.equal(await measureBaseline('/nonexistent-root', 1, EXPECTED, services), null);
  assert.equal(touched, 1, 'the registered-runner list was consulted');
});

test('clause 1: a baseline never starts a local test process; it needs a registered runner to produce a result [C7,V2]', async () => {
  const services = { gateExecutionServices: async () => ({ runners: { effectiveRunners: () => [], runOnRunnerAsync: () => { throw new Error('no run without a runner'); } }, landing: {} }) };
  assert.equal(await measureBaseline('/nonexistent-root', 2, EXPECTED, services), null);
});
