/** @pullboard-test-input source-tree */
/** Real private queue admissions keep submit and review check retries off their caller [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../../../../../../../apps/cli/tests/fixtures/child.js';
import { runFixtureGit } from '../../../../../../../apps/cli/tests/fixtures/child.js';

const SOURCE = join(import.meta.dirname, '../../../../../../..');

/** Exercise the real gate slot and SQLite retry queue with deterministic transport failure ports. */
// Since 4c5e2ac38d (#2512) the gate keeps one of two runners for timed checks by default; these failover cases
// declare no kept runner, so the first configured runner takes the first attempt, as they assert [C7].
function failover(t, { review = false, dropped = false, timedOut = false, leaked = false, exhausted = false, first = true, timingRunner = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-check-failover-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'repo');
  const machine = join(home, 'machine');
  mkdirSync(root);
  mkdirSync(machine);
  const env = { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machine,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Check failover', GIT_AUTHOR_EMAIL: 'failover@example.invalid',
    GIT_COMMITTER_NAME: 'Check failover', GIT_COMMITTER_EMAIL: 'failover@example.invalid' };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN',
    'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_LANDING_RUN', 'PULLBOARD_RELEASE_EXECUTORS']) delete env[key];
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
    runners: ['failed-runner', 'next-runner'].map(host => ({ host, slots: 1, browser: 1 })),
    gate: { runnersFirst: first, runnersOnly: false, runnerWaitMs: 100, memoryFloorMB: 0, timingRunner } }));
  writeFileSync(join(root, 'source.txt'), 'committed source');
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  runFixtureGit(['add', 'source.txt'], { cwd: root, env });
  runFixtureGit(['commit', '-qm', 'test: private check source [C7]'], { cwd: root, env });
  const url = cell => JSON.stringify(pathToFileURL(join(SOURCE, 'packages', cell, 'index.js')).href);
  const marker = join(home, 'local-body');
  const script = `import { withGateSlot, RunnerDropped } from ${url('gate')};
import { Refused } from ${url('kernel')};
import { runnerExecutionServices } from ${url('runners')};
import { landingExecutionServices } from ${url('landing')};
import { listResources } from ${url('resources')};
import { writeFileSync } from 'node:fs';
const executionServices = { runners: { ...runnerExecutionServices(),
  probeRunnerTransport: async () => ({ healthy: false }),
  probeRunnerHealth: async () => ({ healthy: false }),
  refreshRunnerMeasurements: async () => {} }, landing: landingExecutionServices() };
const attempts = [], receipts = [];
let result, failure;
try { result = await withGateSlot(process.cwd(), async lease => {
  const host = lease.runner?.host ?? 'local';
  attempts.push(host);
  if (host === 'local') { writeFileSync(${JSON.stringify(marker)}, 'ran'); return host; }
  if (${JSON.stringify(exhausted)} || host === 'failed-runner') {
    if (${JSON.stringify(timedOut)}) return { isGreen: false, timedOut: true };
    if (${JSON.stringify(dropped)}) throw new RunnerDropped(host, { reason: 'admission-deadline' });
    if (${JSON.stringify(leaked)}) throw Object.assign(new Refused('RUNNER_CLEANUP_TIMEOUT', 'a test left a server running'), { diagnostic: { phase: 'ready', reason: 'cleanup-unverified', cleanup: { id: 'job', stage: 'descendants', reason: ${JSON.stringify(leaked === 'overflow' ? 'child spawn journal overflow or write failure' : 'a descendant outlived the run')}, uncertain: ${JSON.stringify(leaked === 'overflow')}, processes: [{ pid: 4242, command: 'node', started: null, birth: null }] } } });
    throw new Refused('RUNNER_CLEANUP_TIMEOUT', 'the timed-out runner did not prove cleanup');
  }
  return host;
}, { executionServices, itemCheck: ${JSON.stringify(!review)}, kind: ${JSON.stringify(review ? 'review' : 'check')},
  onWait: () => {}, onReceipt: receipt => receipts.push(receipt) });
} catch (error) { failure = { code: error.code, message: error.message }; }
process.stdout.write(JSON.stringify({ result, failure, attempts, receipts,
  holders: listResources({ scope: 'machine' }).flatMap(row => row.holders) }));`;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env, encoding: 'utf8', timeout: 20_000,
  }); // budget: private queue admission and its declared runner-wait deadline must terminate.
  assert.equal(child.status, 0, child.context ?? child.stderr);
  return { ...JSON.parse(child.stdout), localRan: existsSync(marker) };
}

for (const review of [false, true]) {
  test(`${review ? 'review' : 'submit'} cleanup timeout retries only on another runner [C7]`, t => {
    const run = failover(t, { review });
    assert.equal(run.failure, undefined);
    assert.equal(run.result, 'next-runner');
    assert.deepEqual(run.attempts, ['failed-runner', 'next-runner']);
    assert.equal(run.localRan, false);
    assert.equal(run.receipts.at(-1).runner.id, 'next-runner');
    assert.equal(run.receipts.at(-1).runner.kind, 'ssh');
    assert.equal(run.holders.length, 0);
  });
}

test('a dropped submit runner retries remotely and records that runner [C7]', t => {
  const run = failover(t, { dropped: true });
  assert.equal(run.result, 'next-runner');
  assert.deepEqual(run.attempts, ['failed-runner', 'next-runner']);
  assert.equal(run.localRan, false);
  assert.equal(run.receipts.at(-1).runner.id, 'next-runner');
  assert.equal(run.holders.length, 0);
});

test('a timed-out remote check result is the check\'s red, returned once and never retried on another runner [C7]', t => {
  // #3301 (9 Nov): a hanging shard ran three times, 13 minutes each, on two runners before its gate ended.
  const run = failover(t, { timedOut: true });
  assert.equal(run.failure, undefined);
  assert.deepEqual(run.result, { isGreen: false, timedOut: true });
  assert.deepEqual(run.attempts, ['failed-runner'], 'one attempt: a timed-out test is red, not infrastructure');
  assert.equal(run.localRan, false);
  assert.equal(run.holders.length, 0);
});

test('a runner that cannot clean up after the tests ran refuses RUNNER_TEST_LEAK once, with no retry; before READY it stays infrastructure [C7]', t => {
  const run = failover(t, { leaked: true });
  assert.equal(run.failure?.code, 'RUNNER_TEST_LEAK');
  assert.match(run.failure.message, /left processes/u);
  assert.deepEqual(run.attempts, ['failed-runner'], 'the leak is the tests\' red: no other runner runs it again');
  assert.equal(run.holders.length, 0);
  const before = failover(t);
  assert.deepEqual(before.attempts, ['failed-runner', 'next-runner'], 'a cleanup timeout with no READY is still retried');
  const overflow = failover(t, { leaked: 'overflow' });
  assert.notEqual(overflow.failure?.code, 'RUNNER_TEST_LEAK', 'a cleanup the runner could not verify (an overflowed spawn journal) is no proof of a test leak');
  assert.deepEqual(overflow.attempts, ['failed-runner', 'next-runner'], 'it is the runner\'s infrastructure and runs on another runner');
});

for (const dropped of [false, true]) {
  test(`exhausted ${dropped ? 'dropped' : 'timed-out'} runners refuse by name without a local check [C7]`, t => {
    const run = failover(t, { exhausted: true, dropped });
    assert.equal(run.failure?.code, 'RUNNER_UNAVAILABLE');
    assert.match(run.failure.message, /failed-runner/u);
    assert.match(run.failure.message, /next-runner/u);
    assert.deepEqual(run.attempts, ['failed-runner', 'next-runner']);
    assert.equal(run.localRan, false);
    assert.equal(run.holders.length, 0);
  });
}

test('clause 1: with the default kept timing runner, an ordinary check goes first to the runner not kept [C7]', t => {
  // gate.timingRunner 'auto' keeps failed-runner (no measured headroom or cores, so registration order) for timed checks.
  const run = failover(t, { dropped: true, timingRunner: 'auto' });
  assert.equal(run.failure, undefined);
  assert.equal(run.result, 'next-runner');
  assert.deepEqual(run.attempts, ['next-runner']);
  assert.equal(run.localRan, false);
  assert.equal(run.receipts.at(-1).runner.id, 'next-runner');
  assert.equal(run.holders.length, 0);
});

test('runners-first opt-out retains the explicit local check control [C7]', t => {
  const run = failover(t, { first: false });
  assert.equal(run.result, 'local');
  assert.deepEqual(run.attempts, ['local']);
  assert.equal(run.localRan, true);
  assert.equal(run.holders.length, 0);
});


/** Drive both submission phases through the real slot and private queue with remote command outcomes. */
function phaseEvidence(t, { timedOut = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-phase-evidence-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'repo');
  const machine = join(home, 'machine');
  mkdirSync(root);
  mkdirSync(machine);
  const env = { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machine,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Phase evidence', GIT_AUTHOR_EMAIL: 'evidence@example.invalid',
    GIT_COMMITTER_NAME: 'Phase evidence', GIT_COMMITTER_EMAIL: 'evidence@example.invalid' };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN',
    'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_LANDING_RUN', 'PULLBOARD_RELEASE_EXECUTORS']) delete env[key];
  writeFileSync(join(machine, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1,
    runners: ['first-runner', 'second-runner'].map(host => ({ host, slots: 1, browser: 1 })),
    gate: { runnersFirst: true, memoryFloorMB: 0, timingRunner: false } }));
  writeFileSync(join(root, 'source.txt'), 'committed phase evidence source');
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  runFixtureGit(['add', 'source.txt'], { cwd: root, env });
  runFixtureGit(['commit', '-qm', 'test: private phase source [C7,V4]'], { cwd: root, env });
  const url = cell => JSON.stringify(pathToFileURL(join(SOURCE, 'packages', cell, 'index.js')).href);
  const script = `import { runSubmitGate } from ${url('gate')};
import { Refused } from ${url('kernel')};
import { runnerExecutionServices } from ${url('runners')};
import { landingExecutionServices } from ${url('landing')};
import { listResources } from ${url('resources')};
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const calls = [];
const output = 'TAP version 13\\nnot ok 1 - retained failure [C7]\\n# fail 1\\n';
const log = join(process.cwd(), '.git', 'phase-evidence.log');
const executionServices = { runners: { ...runnerExecutionServices(),
  probeRunnerTransport: async () => ({ healthy: false }),
  probeRunnerHealth: async () => ({ healthy: false }),
  refreshRunnerMeasurements: async () => {},
  runOnRunnerAsync: async (_root, command, options) => {
    calls.push({ command, host: options.runner.host });
    if (${JSON.stringify(timedOut)}) return command === 'fixture-check' && options.runner.host === 'first-runner'
      ? { isGreen: false, timedOut: true, exitCode: 124, output }
      : { isGreen: true, exitCode: 0, output: 'ok' };
    if (command === 'fixture-check') return { isGreen: false, exitCode: 1, output };
    throw new Refused('RUNNER_UNAVAILABLE', 'the proof runner is unavailable');
  } }, landing: landingExecutionServices() };
let code, result;
try { result = await runSubmitGate(process.cwd(), { gate: 'true', affectedTests: 'fixture-proof' }, {
  executionServices, staticChecked: true, outputLog: log,
  plan: { check: 'fixture-check', selection: { full: false, reason: '', files: ['test/proof.test.js'] },
    deferred: false, deferFullFallback: false, deferSelection: false, invariants: [], registryGuards: [],
    proofFiles: ['test/proof.test.js'], fullConfig: { gate: 'true' }, hasFinalProof: true, phases: [], testTiers: null },
}); } catch (error) { code = error.code; }
process.stdout.write(JSON.stringify({ code, result, calls, output: readFileSync(log + '.check.log', 'utf8'),
  expected: output, holders: listResources({ scope: 'machine' }).flatMap(row => row.holders) }));`;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.context ?? child.stderr);
  return JSON.parse(child.stdout);
}

test('a remote proof refusal preserves the completed frozen-check output [C7,V4]', t => {
  const result = phaseEvidence(t);
  assert.equal(result.code, 'RUNNER_UNAVAILABLE');
  assert.deepEqual(result.calls.map(call => call.command),
    ['fixture-check', "fixture-proof './test/proof.test.js'", 'fixture-check', "fixture-proof './test/proof.test.js'"]);
  assert.equal(new Set(result.calls.map(call => call.host)).size, 2, 'the bounded retry uses the other registered runner');
  assert.equal(result.output, result.expected, 'the red check remains inspectable after the proof refuses');
  assert.equal(result.holders.length, 0, 'the failed proof leaves no private lease behind');
});


test('runSubmitGate records a timeout in its frozen check as the check\'s red, without a retry on another runner [C7]', t => {
  const run = phaseEvidence(t, { timedOut: true });
  assert.equal(run.code, undefined);
  assert.equal(run.result.isGreen, false);
  assert.equal(run.result.check.green, false);
  assert.deepEqual(run.calls.map(call => call.command), ['fixture-check', "fixture-proof './test/proof.test.js'"]);
  assert.deepEqual(run.calls.map(call => call.host), ['first-runner', 'first-runner']);
  assert.equal(run.output, run.expected, 'the timed-out check output is the recorded red');
  assert.equal(run.holders.length, 0, 'the one attempt releases its private lease');
});
