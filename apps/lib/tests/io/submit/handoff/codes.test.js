/** RUNNER_RESULT_INVALID and RESOURCE_LEASE_LOST requeue the same candidate as infrastructure, never a red [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INFRASTRUCTURE_CODES,
  submitUntilSettled,
} from '../../../../index.js';
import { INFRASTRUCTURE_CODES as board } from '../../../../../../packages/store/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';

const HOST = 'runner-7.example';
const CASES = {
  RUNNER_RESULT_INVALID: () => new Refused('RUNNER_RESULT_INVALID', `runner ${HOST} answers SSH and Node but a second attempt lacks a valid completion`),
  RESOURCE_LEASE_LOST: () => Object.assign(new Refused('RESOURCE_LEASE_LOST', 'resource lease for "gate" is no longer held'), { lease: { runner: { host: HOST } } }),
};

/** Run a hand-off whose first attempt fails with `error`, and collect what the queue said and decided. */
async function handoff(error, retries) {
  const said = [];
  let runs = 0;
  const outcome = await submitUntilSettled(async () => {
    runs += 1;
    if (runs === 1 || retries === 0) throw error;
    return { green: true };
  }, { say: line => said.push(line), healthy: async () => true, wait: async () => {}, retries });
  return { outcome, said, runs };
}

for (const code of Object.keys(CASES)) {
  test(`clause 1: ${code} is infrastructure and requeues the same candidate, never a red [C7]`, async () => {
    assert.ok(board.has(code) && INFRASTRUCTURE_CODES.has(code));
    const { outcome, runs } = await handoff(CASES[code]());
    assert.equal(runs, 2);
    assert.equal(outcome.attempts[0].code, code);
    assert.deepEqual(outcome.result, { green: true });
    // The retry bound is the existing one: when spent, the stop is the infrastructure code, not the builder's red.
    await assert.rejects(handoff(CASES[code](), 0), error => error.code === 'GATE_INFRA_EXHAUSTED' && error.attempts.length === 1);
  });

  test(`clause 2: the ${code} requeue note names the code and the runner [C7]`, async () => {
    const { said } = await handoff(CASES[code]());
    assert.equal(said.length, 1);
    assert.match(said[0], new RegExp(code, 'u'));
    assert.ok(said[0].includes(HOST), said[0]);
    assert.match(said[0], /requeueing the same candidate.*not a red/u);
  });
}
