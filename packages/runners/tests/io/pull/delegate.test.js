/** A pulled version mismatch refreshes once and keeps spec validation bounded [C7,#12755]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runOnRunnerAsync } from '../../../src/io/pull/delegate.js';

const RUNNER = { host: 'runner.example.invalid', slots: 1, browser: 0 };

/** Run a pulled trip with controller ports that return explicit protocol refusals. */
async function pulledTrip(mode) {
  const calls = [];
  let finishes = 0;
  const custody = { job() {}, ready() {}, unavailable: () => null, observationProblem() {}, close() {} };
  const call = async part => {
    calls.push(part);
    if (part === '--submit') return { id: 'job-1', recovery: {}, host: RUNNER.host, toolingSha: 'a'.repeat(64), reusedRuntime: false };
    finishes++;
    if (mode === 'once' && finishes === 2) return { isGreen: true, output: '45678', phases: {} };
    if (mode === 'malformed') {
      const failure = new Error('runner refused malformed work specification');
      failure.code = 'RUNNER_WORK_SPEC';
      failure.calls = [...calls];
      throw failure;
    }
    const failure = new Error('runner refused invalid work specification: controller version 1, runner version 2');
    failure.code = 'RUNNER_WORK_SPEC';
    failure.workSpecVersions = { controller: 1, runner: 2 };
    failure.calls = [...calls];
    throw failure;
  };
  const waitRunnerJob = async () => ({ end: 'result', job: { exit: { code: 0, signal: null } } });
  const result = await runOnRunnerAsync(process.cwd(), 'node -e 0', { runner: RUNNER, metadata: {} }, {
    call, waitRunnerJob, controllerDeadline: () => custody, runnerItemState: () => null,
  });
  return { calls, result };
}

test('runners.pull.a-pulled-version-mismatch-refreshes-once: a pulled mismatch refreshes once and succeeds, a second mismatch names both versions, and malformed specs never retry [C7,#12755]', async () => {
  const once = await pulledTrip('once');
  assert.equal(once.result.isGreen, true);
  assert.match(once.result.output, /45678/u);
  assert.deepEqual(once.calls, ['--submit', '--finish', '--submit', '--finish']);

  let twice;
  await assert.rejects(pulledTrip('twice'), error => {
    twice = error;
    return error.code === 'RUNNER_WORK_SPEC' && /controller version 1, runner version 2/u.test(error.message);
  });
  assert.deepEqual(twice.workSpecVersions, { controller: 1, runner: 2 });
  assert.deepEqual(twice.calls, ['--submit', '--finish', '--submit', '--finish']);

  let malformed;
  await assert.rejects(pulledTrip('malformed'), error => {
    malformed = error;
    return error.code === 'RUNNER_WORK_SPEC' && !error.workSpecVersions;
  });
  assert.equal(malformed.message, 'runner refused malformed work specification');
  assert.deepEqual(malformed.calls, ['--submit', '--finish'], 'a malformed refusal without trusted version data does not retry');
});
