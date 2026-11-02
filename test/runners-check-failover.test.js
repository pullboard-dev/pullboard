/** @pullboard-test-input source-tree */
/** Real private queue admissions keep submit and review check retries off their caller [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild, runFixtureGit } from './fixture-child.js';

const SOURCE = join(import.meta.dirname, '..');

/** Exercise the real gate slot and SQLite retry queue with deterministic transport failure ports. */
function failover(t, { review = false, dropped = false, timedOut = false, exhausted = false, first = true } = {}) {
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
    gate: { runnersFirst: first, runnersOnly: false, runnerWaitMs: 100, memoryFloorMB: 0 } }));
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

test('a timed-out remote check result retries on another runner [C7]', t => {
  const run = failover(t, { timedOut: true });
  assert.equal(run.failure, undefined);
  assert.equal(run.result, 'next-runner');
  assert.deepEqual(run.attempts, ['failed-runner', 'next-runner']);
  assert.equal(run.localRan, false);
  assert.equal(run.receipts.at(-1).runner.id, 'next-runner');
  assert.equal(run.holders.length, 0);
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

test('runners-first opt-out retains the explicit local check control [C7]', t => {
  const run = failover(t, { first: false });
  assert.equal(run.result, 'local');
  assert.deepEqual(run.attempts, ['local']);
  assert.equal(run.localRan, true);
  assert.equal(run.holders.length, 0);
});
