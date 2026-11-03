/** An infrastructure failure requeues the same candidate on a healthy runner; only a test or check failure goes red [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { executionServicesSource } from './gate-execution-fixture.js';
import { runFixtureChild } from './fixture-child.js';
import { HOST, installSshStandIn } from './runner-ssh-fixture.js';
import { infrastructureFailure, submitUntilSettled } from '../apps/lib/index.js';
import { Refused } from '../packages/kernel/index.js';

const url = file => JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', file)).href);

/** A private project whose only executor is one SSH stand-in runner; no real host or machine setting is touched. */
function fixture(t) {
  const e2e = createE2eHelpers(); t.after(e2e.cleanup);
  const box = e2e.project('true');
  const bin = join(box.dir, 'requeue-bin'), worker = join(box.dir, 'requeue-worker');
  const home = join(box.dir, 'requeue-home'), machineHome = join(home, '.pullboard');
  for (const folder of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  const requests = join(box.dir, 'requests.jsonl');
  installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  const runner = { host: HOST, slots: 1, browser: 0, node: process.execPath };
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
    gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true, runnerWaitMs: 2000 }, runners: [runner],
  }));
  return { ...box, runner, requests };
}

/**
 * The child runs the real gate slot on the stand-in runner inside the queued worker's requeue loop. Its action fails
 * the way runners fail (transport lost, cleanup timeout, wait deadline) before a real green, or returns `final`.
 */
function scenario(box, failures, final = '{isGreen:true,output:"REQUEUE_OK"}') {
  const gate = pathToFileURL(join(import.meta.dirname, '../src/gate.js')).href;
  const source = `import { withGateSlot } from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
import { RunnerDropped } from ${url('packages/gate/src/core/gate-policy-load.js')};
import { Refused } from ${url('packages/kernel/index.js')};
import { submitUntilSettled } from ${url('apps/lib/index.js')};
const failures = ${JSON.stringify(failures)};
let calls = 0; const seen = [], said = [];
const fail = (kind, host) => kind === 'transport' ? new RunnerDropped(host, { reason: 'fixture transport lost', phase: 'ready' })
  : kind === 'cleanup' ? new Refused('RUNNER_CLEANUP_TIMEOUT', 'fixture runner cleanup timed out')
  : kind === 'deadline' ? new Refused('RUNNER_WAIT_DEADLINE', 'fixture runner wait deadline passed')
  : new Refused('GATE_RED', 'fixture test failure');
const run = () => withGateSlot(process.cwd(), async lease => {
  calls += 1; seen.push(lease.runner?.host ?? 'local');
  if (calls <= failures.length) throw fail(failures[calls - 1], lease.runner?.host);
  return ${final};
}, { executionServices, remote: true, runnerOnly: true, runnerWaitMs: 2000, itemCheck: true, agent: 'requeue-test', kind: 'submit', item: 'fixture', onWait() {} });
try {
  const { result, attempts } = await submitUntilSettled(run, { say: line => said.push(line), wait: async () => {} });
  console.log(JSON.stringify({ green: result.isGreen, output: result.output, calls, seen, attempts, said }));
} catch (error) { console.log(JSON.stringify({ refused: error.code, calls, seen, said })); }`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('a gate whose runner drops (transport lost, cleanup timeout, wait deadline) reruns on a healthy runner and reports that result; the builder sees no red [C7]', t => {
  const box = fixture(t);
  const result = scenario(box, ['transport', 'cleanup', 'deadline', 'transport', 'cleanup']);
  assert.equal(result.refused, undefined, `no refusal reaches the builder: ${JSON.stringify(result)}`);
  assert.equal(result.green, true, 'the healthy rerun reports its own result');
  assert.equal(result.output, 'REQUEUE_OK');
  assert.equal(result.calls, 6, 'every infrastructure failure ran the same candidate again; no retry limit');
  assert.ok(result.seen.every(host => host === box.runner.host), 'every attempt ran on the healthy runner');
  assert.ok(result.attempts.length >= 2, 'more than the old single retry was requeued');
  assert.ok(result.attempts.every(row => ['RUNNER_INFRA_RETRY_EXHAUSTED', 'RUNNER_WAIT_DEADLINE', 'RUNNER_CLEANUP_TIMEOUT', 'TRANSPORT_LOST'].includes(row.code)), JSON.stringify(result.attempts));
  assert.ok(result.attempts.some(row => row.code === 'RUNNER_WAIT_DEADLINE'), 'a wait deadline requeued');
  assert.ok(result.said.every(line => /requeueing the same candidate, not a red$/u.test(line)), result.said.join('\n'));
  assert.ok(readFileSync(box.requests, 'utf8').includes(box.runner.host), 'the attempts used only the private stand-in');
});

test('a test failure goes red on its first attempt and is never requeued [C7]', t => {
  const box = fixture(t);
  const thrown = scenario(box, ['red']);
  assert.equal(thrown.refused, 'GATE_RED');
  assert.equal(thrown.calls, 1);
  assert.deepEqual(thrown.said, []);
  const red = scenario(box, [], '{isGreen:false,output:"TEST_RED"}');
  assert.equal(red.green, false, 'a red check result is the result');
  assert.equal(red.calls, 1);
  assert.deepEqual(red.attempts, []);
});

test('infrastructure failures are named by code, a dropped runner or a locked board; real failures are not [C7]', async () => {
  for (const code of ['RUNNER_UNAVAILABLE', 'RUNNER_JOB_LOST', 'RUNNER_CLEANUP_TIMEOUT', 'RUNNER_WAIT_DEADLINE', 'RUNNER_INFRA_RETRY_EXHAUSTED', 'BOARD_BUSY', 'SLOT_DB_LOCKED', 'MERGE_CHECK_FAILED']) {
    assert.equal(infrastructureFailure(new Refused(code, 'fixture')), code);
  }
  assert.equal(infrastructureFailure(Object.assign(new Error('runner x disconnected'), { name: 'RunnerDropped' })), 'TRANSPORT_LOST');
  assert.equal(infrastructureFailure(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' })), 'DATABASE_LOCKED');
  for (const code of ['GATE_RED', 'CHECK_RED', 'RUNNER_SECRET', 'RUNNER_RESULT_INVALID', 'HEAD_NOT_NEW']) {
    assert.equal(infrastructureFailure(new Refused(code, 'database is locked in the test output')), null, code);
  }
  // With no healthy executor the candidate waits in the queue rather than going red, then runs once one answers.
  let healthyAfter = 2, waits = 0, calls = 0;
  const { result, attempts } = await submitUntilSettled(async () => {
    calls += 1;
    if (calls === 1) throw new Refused('RUNNER_UNAVAILABLE', 'fixture: every runner is down');
    return 'GREEN';
  }, { healthy: async () => healthyAfter-- <= 0, wait: async () => { waits += 1; } });
  assert.equal(result, 'GREEN');
  assert.equal(calls, 2);
  assert.deepEqual(attempts.map(row => row.code), ['RUNNER_UNAVAILABLE']);
  assert.equal(waits, 3, 'two waits for a healthy executor, then the requeue pause');
});
