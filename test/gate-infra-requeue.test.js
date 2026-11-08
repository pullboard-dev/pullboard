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
import { preferOtherRunners } from '../packages/gate/index.js';

const url = file => JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', file)).href);

/** A private project whose only executor is one SSH stand-in runner; no real host or machine setting is touched. */
function fixture(t, { second = false } = {}) {
  const e2e = createE2eHelpers(); t.after(e2e.cleanup);
  const box = e2e.project('true');
  const bin = join(box.dir, 'requeue-bin'), worker = join(box.dir, 'requeue-worker');
  const home = join(box.dir, 'requeue-home'), machineHome = join(home, '.pullboard');
  for (const folder of [bin, worker, home, machineHome, box.env.PULLBOARD_MACHINE_HOME]) mkdirSync(folder, { recursive: true });
  const requests = join(box.dir, 'requests.jsonl');
  installSshStandIn({ bin, worker, home, machineHome, requests, nodeCommand: process.execPath });
  box.env.PATH = `${bin}:${box.env.PATH}`;
  const runner = { host: HOST, slots: 1, browser: 0, node: process.execPath };
  // The second runner is the same private stand-in under another host name: a healthy alternative.
  const other = { host: `${HOST}-b`, slots: 1, browser: 0, node: process.execPath };
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({
    gateSlots: 0, browserSlots: 0, gate: { runnersFirst: true, runnerWaitMs: 2000 }, runners: second ? [runner, other] : [runner],
  }));
  return { ...box, runner, other, requests };
}

/**
 * The child runs the real gate slot on the stand-in runner inside the queued worker's requeue loop. Its action fails
 * the way runners fail (transport lost, cleanup timeout, wait deadline) before a real green, or returns `final`.
 */
function scenario(box, failures, final = '{isGreen:true,output:"REQUEUE_OK"}', { brokenFirstHost = null } = {}) {
  const gate = pathToFileURL(join(import.meta.dirname, '../packages/gate/index.js')).href;
  const source = `import { withGateSlot } from ${JSON.stringify(gate)};
${executionServicesSource(gate)}
import { RunnerDropped } from ${url('packages/gate/src/core/gate-policy-load.js')};
import { Refused } from ${url('packages/kernel/index.js')};
import { submitUntilSettled } from ${url('apps/lib/index.js')};
const failures = ${JSON.stringify(failures)}, brokenFirstHost = ${JSON.stringify(brokenFirstHost)};
let broken = null;
let calls = 0; const seen = [], said = [];
const fail = (kind, host) => kind === 'transport' ? new RunnerDropped(host, { reason: 'fixture transport lost', phase: 'ready' })
  : kind === 'cleanup' ? new Refused('RUNNER_CLEANUP_TIMEOUT', 'fixture runner cleanup timed out')
  : kind === 'deadline' ? new Refused('RUNNER_WAIT_DEADLINE', 'fixture runner wait deadline passed')
  : new Refused('GATE_RED', 'fixture test failure');
const run = () => withGateSlot(process.cwd(), async lease => {
  calls += 1; seen.push(lease.runner?.host ?? 'local');
  // With brokenFirstHost, the first runner admitted fails that way on every call: a runner that keeps failing.
  if (brokenFirstHost) { broken ??= lease.runner?.host; if (lease.runner?.host === broken) throw fail(brokenFirstHost, broken); }
  else if (calls <= failures.length) throw fail(failures[calls - 1], lease.runner?.host);
  return ${final};
}, { executionServices, remote: true, runnerOnly: true, runnerWaitMs: 2000, itemCheck: true, agent: 'requeue-test', kind: 'submit', item: 'fixture', onWait() {} });
try {
  const { result, attempts, avoided } = await submitUntilSettled(run, { say: line => said.push(line), wait: async () => {} });
  console.log(JSON.stringify({ green: result.isGreen, output: result.output, calls, seen, attempts, said, avoided }));
} catch (error) { console.log(JSON.stringify({ refused: error.code, calls, seen, said })); }`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 120_000,
  });
  assert.equal(result.status, 0, result.failure || result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split('\n').at(-1));
}

test('a gate whose runner drops twice, then succeeds, ends green with no red reported [C7]', t => {
  const box = fixture(t);
  const result = scenario(box, ['transport', 'cleanup']);
  assert.equal(result.refused, undefined, `no refusal reaches the builder: ${JSON.stringify(result)}`);
  assert.equal(result.green, true, 'the healthy rerun reports its own result');
  assert.equal(result.output, 'REQUEUE_OK');
  assert.equal(result.calls, 3, 'the same candidate ran again after each drop');
  assert.ok(result.attempts.length <= 3, 'within the bounded retries');
  assert.ok(result.said.every(line => /requeueing the same candidate(?:, avoiding [^,]+)?, not a red$/u.test(line)), result.said.join('\n'));
  assert.ok(readFileSync(box.requests, 'utf8').includes(box.runner.host), 'the attempts used only the private stand-in');
});

test('after 3 retries a runner that keeps dropping ends as an infrastructure stop, never a red [C7]', t => {
  const box = fixture(t);
  const result = scenario(box, Array(20).fill('transport'));
  assert.equal(result.refused, 'GATE_INFRA_EXHAUSTED', JSON.stringify(result));
  assert.ok(result.calls <= 8, `bounded: ${result.calls} runs`);
});

for (const kind of ['transport', 'cleanup']) {
  test(`a runner that keeps failing (${kind}) is avoided: the same candidate completes on the healthy second runner, no red [C7]`, t => {
    const box = fixture(t, { second: true });
    const result = scenario(box, [], undefined, { brokenFirstHost: kind });
    assert.equal(result.refused, undefined, `no refusal reaches the builder: ${JSON.stringify(result)}`);
    assert.equal(result.green, true);
    assert.equal(result.output, 'REQUEUE_OK');
    const [broken] = result.seen;
    const healthy = [box.runner.host, box.other.host].find(host => host !== broken);
    assert.equal(result.seen.at(-1), healthy, `the candidate completed on the other runner: ${JSON.stringify(result.seen)}`);
    assert.equal(result.seen.filter(host => host === broken).length, 1, `the failed runner never took the candidate again: ${JSON.stringify(result.seen)}`);
    assert.ok(result.avoided.includes(broken), 'the failed host is carried as avoided');
    assert.ok(!result.avoided.includes(healthy));
  });
}

test('clause 1: a runner that keeps hitting its wait deadline stops GATE_INFRA_EXHAUSTED for the coordinator, never a red to the builder [C7]', t => {
  const box = fixture(t, { second: true });
  const result = scenario(box, [], undefined, { brokenFirstHost: 'deadline' });
  assert.equal(result.refused, 'GATE_INFRA_EXHAUSTED', `a wait deadline is infrastructure and the bounded retries end as such: ${JSON.stringify(result)}`);
  assert.equal(result.calls, 4, 'the first attempt and exactly 3 retries');
  assert.ok(result.said.every(line => /RUNNER_UNAVAILABLE.*requeueing the same candidate/u.test(line)), result.said.join('\n'));
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

test('clause 1: infrastructure failures are named by code, a dropped runner, an invalid runner result (#3303) or a locked board; real failures are not [C7]', async () => {
  for (const code of ['RUNNER_UNAVAILABLE', 'RUNNER_JOB_LOST', 'RUNNER_CLEANUP_TIMEOUT', 'RUNNER_WAIT_DEADLINE', 'RUNNER_INFRA_RETRY_EXHAUSTED', 'BOARD_BUSY', 'SLOT_DB_LOCKED', 'MERGE_CHECK_FAILED', 'RUNNER_RESULT_INVALID', 'RESOURCE_LEASE_LOST']) {
    assert.equal(infrastructureFailure(new Refused(code, 'fixture')), code);
  }
  assert.equal(infrastructureFailure(Object.assign(new Error('runner x disconnected'), { name: 'RunnerDropped' })), 'TRANSPORT_LOST');
  assert.equal(infrastructureFailure(Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' })), 'DATABASE_LOCKED');
  for (const code of ['GATE_RED', 'CHECK_RED', 'RUNNER_SECRET', 'HEAD_NOT_NEW']) {
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

test('the requeue is bounded at 3 retries and ends GATE_INFRA_EXHAUSTED for the coordinator [C7]', async () => {
  let calls = 0;
  await assert.rejects(submitUntilSettled(async () => { calls += 1; throw new Refused('RUNNER_UNAVAILABLE', 'fixture: down'); },
    { healthy: async () => true, wait: async () => {} }), error => error.code === 'GATE_INFRA_EXHAUSTED' && error.attempts.length === 4);
  assert.equal(calls, 4, 'the first attempt and exactly 3 retries');
  let waited = 0;
  await assert.rejects(submitUntilSettled(async () => { throw new Refused('RUNNER_UNAVAILABLE', 'fixture: down'); },
    { healthy: async () => false, wait: async () => { waited += 1; } }), { code: 'GATE_INFRA_EXHAUSTED' });
  assert.ok(waited > 0 && waited <= 20, 'waiting for a healthy executor is bounded too');
});

test('a runner that failed earlier and recovered takes the rerun when the other stays unreachable [C7]', async () => {
  const pool = [{ host: 'runner-a' }, { host: 'runner-b' }];
  const used = [];
  const { result } = await submitUntilSettled(async (attempt, avoided) => {
    const host = preferOtherRunners(pool, avoided)[0].host;
    used.push(host);
    if (attempt === 1) throw Object.assign(new Refused('RUNNER_JOB_LOST', 'fixture: runner a dropped'), { runnerHost: 'runner-a' });
    if (host === 'runner-b') throw new Refused('RUNNER_WAIT_DEADLINE', 'fixture: runner b never answered');
    return `GREEN on ${host}`;
  }, { healthy: async () => true, wait: async () => {} });
  assert.deepEqual(used, ['runner-a', 'runner-b', 'runner-a'], 'a, now recovered, re-enters the pool after b fails');
  assert.equal(result, 'GREEN on runner-a');
});

test('lock stops wait without spending runner retries, bounded on their own, and a lost lease stays a counted retry [C7]', async () => {
  assert.equal(infrastructureFailure(new Refused('RESOURCE_LEASE_LOST', 'the queued resource lease disappeared during item renewal')), 'RESOURCE_LEASE_LOST');
  let calls = 0;
  const { result, attempts, lockWaits } = await submitUntilSettled(async () => {
    calls += 1;
    if (calls <= 4) throw new Refused(calls % 2 ? 'SLOT_DB_LOCKED' : 'BOARD_BUSY', 'fixture');
    return 'GREEN';
  }, { healthy: async () => true, wait: async () => {} });
  assert.equal(result, 'GREEN', 'four lock failures, more than the 3 runner retries, still end green');
  assert.deepEqual(attempts, [], 'lock waits are not runner attempts');
  assert.equal(lockWaits.count, 4);
  calls = 0;
  await assert.rejects(submitUntilSettled(async () => { calls += 1; throw new Refused('BOARD_BUSY', 'fixture'); },
    { healthy: async () => true, wait: async () => {}, lockWaitLimit: 5 }), error => error.code === 'GATE_INFRA_EXHAUSTED' && /last BOARD_BUSY/u.test(error.message));
  assert.equal(calls, 6, 'the first attempt and exactly the lock wait bound of reruns');
  calls = 0;
  const lost = await submitUntilSettled(async () => { calls += 1; if (calls === 1) throw new Refused('RESOURCE_LEASE_LOST', 'fixture'); return 'GREEN'; }, { healthy: async () => true, wait: async () => {} });
  assert.equal(lost.attempts.length, 1, 'a lost lease is a counted runner retry, as #3303 requires');
  assert.equal(lost.lockWaits.count, 0);
});

test('clause 2: each infrastructure rerun records its code once, before the rerun is admitted [C7]', async () => {
  const order = [];
  let calls = 0;
  const { result } = await submitUntilSettled(async () => {
    calls += 1;
    order.push(`run ${calls}`);
    if (calls === 1) throw new Refused('GIT_READ_INFRASTRUCTURE', 'fixture: git read failed');
    if (calls === 2) throw new Refused('TRANSPORT_LOST', 'fixture: runner lost');
    return 'green';
  }, { say: () => {}, wait: async () => {}, healthy: async () => true,
    onInfrastructure: async rerun => { order.push(`record ${rerun.code} after attempt ${rerun.attempt}`); } });
  assert.equal(result, 'green');
  assert.deepEqual(order, ['run 1', 'record GIT_READ_INFRASTRUCTURE after attempt 1', 'run 2', 'record TRANSPORT_LOST after attempt 2', 'run 3']);
});
