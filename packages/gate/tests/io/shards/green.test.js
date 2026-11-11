/** @pullboard-test-input source-tree */
/** A builder's green pullboard test run is the gate's proof of the same files at the same tree, and nothing else [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { plainCheckRun } from '../../../src/io/shards/green.js';
import { recordGreenRun } from '../../../src/io/shards/green.js';
import { reusableGreenRun } from '../../../src/io/shards/green.js';
import { runFixtureChild } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../apps/cli/tests/fixtures/testkit.js';
import { fixtureCommittedGraph } from '../../../../../apps/cli/tests/fixtures/testkit.js';

const SOURCE = join(import.meta.dirname, '../../../../..');
const RUNNER = 'node packages/gate/src/io/run/tests.js';
const FILE = 'test/one.test.js';
const TOOLING = 'a'.repeat(64);
const TIMING = '11111111-2222-4333-8444-555555555555';

/** A real repository (no commit yet) beside a private machine home; `commit()` adds a commit and returns its commit and tree. */
function repository(t) {
  const { root: home } = privateFixtureFiles('pullboard-green-proof-');
  const repo = fixtureCommittedGraph('pullboard-green-repo-');
  t.after(() => { rmSync(home, { recursive: true, force: true }); rmSync(repo.root, { recursive: true, force: true }); });
  const machine = join(home, 'machine');
  mkdirSync(machine);
  const env = { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machine, PULLBOARD_INFRA_RETRY_BACKOFF_MS: '0',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN',
    'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_LANDING_RUN', 'PULLBOARD_RELEASE_EXECUTORS']) delete env[key];
  let n = 0;
  const commit = () => {
    repo.put('source.txt', `source ${n++}\n`);
    const at = repo.commit();
    return { commit: at, tree: runFixtureGit(['rev-parse', 'HEAD^{tree}'], { cwd: repo.root, env }) };
  };
  return { root: repo.root, machine, env, commit, folder: join(machine, 'shard-passes') };
}

/** A runner's green run of `files` at a source, as runOnRunnerAsync returns it. */
function greenRun(source, { tooling = TOOLING, green = true } = {}) {
  return { isGreen: green, exitCode: green ? 0 : 1, output: `TAP version 13\nok 1 - one [C7]\n# timing ${TIMING}\n`, environment: { node: 'v22.22.2', platform: 'darwin', arch: 'arm64' },
    executionRunner: 'runner-a', executionSource: { commit: source.commit, tree: source.tree, tooling: { sha256: tooling } }, remoteWallMs: 64_000, seconds: 64 };
}

test('clause 2: only the same tree, the same files and the same runner tooling reuse a recorded green run [C7]', t => {
  const repo = repository(t);
  const first = repo.commit();
  const wanted = { tree: first.tree, head: first.commit, runner: RUNNER, files: [FILE], tooling: TOOLING, folder: repo.folder };
  assert.equal(recordGreenRun(greenRun(first), { runner: RUNNER, files: [FILE], timingRunId: TIMING, folder: repo.folder }), true);
  const reused = reusableGreenRun({ ...wanted, timingRunId: 'ffffffff-2222-4333-8444-555555555555' });
  assert.equal(reused.isGreen, true);
  assert.match(reused.output, /^# reused green run 11111111-2222-4333-8444-555555555555 of 1 file\(s\) at tree /u, 'the output names the run reused');
  assert.match(reused.output, /# timing ffffffff-2222-4333-8444-555555555555/u, 'the outcome frames are rebound to this run');
  assert.equal(reused.executionSource.tree, first.tree);
  const second = repo.commit();
  assert.equal(reusableGreenRun({ ...wanted, tree: second.tree, head: second.commit }), null, 'another tree runs again');
  assert.equal(reusableGreenRun({ ...wanted, files: [FILE, 'test/two.test.js'] }), null, 'another file set runs again');
  assert.equal(reusableGreenRun({ ...wanted, runner: 'node other/runner.js' }), null, 'another runner command runs again');
  assert.equal(reusableGreenRun({ ...wanted, tooling: 'b'.repeat(64) }), null, 'other runner tooling runs again');
  assert.equal(reusableGreenRun({ ...wanted, tooling: null }), null, 'unknown tooling runs again');
  assert.equal(recordGreenRun(greenRun(second, { green: false }), { runner: RUNNER, files: [FILE], folder: repo.folder }), false, 'a red is never recorded');
  assert.equal(recordGreenRun({ ...greenRun(second), executionSource: { commit: second.commit, tree: second.tree } }, { runner: RUNNER, files: [FILE], folder: repo.folder }), false,
    'a run without runner tooling is never recorded');
  assert.equal(reusableGreenRun({ ...wanted, tree: second.tree, head: second.commit }), null);
});

test('clause 2: only a plain runner command over test files is a check a recorded run can stand in for [C7]', () => {
  assert.deepEqual(plainCheckRun(`${RUNNER} ./${FILE}`), { runner: RUNNER, files: [FILE] });
  assert.equal(plainCheckRun(`${RUNNER} ${FILE} && rm -rf x`), null);
  assert.equal(plainCheckRun(`! ${RUNNER} ${FILE}`), null);
  assert.equal(plainCheckRun(`${RUNNER} --test-name-pattern=x ${FILE}`), null);
  assert.equal(plainCheckRun('test ! -e src/x.js'), null);
});

/**
 * Drive the real submit gate, slot and receipts in a child: a recorded green run of the check's file at `recordAt` is
 * seeded first, and the stub runner counts every command it is asked to run.
 */
function gateRun(t, { stale = false } = {}) {
  const repo = repository(t);
  const recorded = repo.commit();
  if (stale) repo.commit();
  fixtureMachineSettings(repo.machine, { gateSlots: 1, browserSlots: 1,
    runners: [{ host: 'runner-b', slots: 1, browser: 1 }], gate: { runnersFirst: true, runnerWaitMs: 100, memoryFloorMB: 0, timingRunner: false } });
  const url = cell => JSON.stringify(pathToFileURL(join(SOURCE, 'packages', cell, 'index.js')).href);
  const green = JSON.stringify(pathToFileURL(join(SOURCE, 'packages/gate/src/io/shards/green.js')).href);
  const script = `import { runSubmitGate } from ${url('gate')};
import { recordGreenRun } from ${green};
import { runnerExecutionServices } from ${url('runners')};
import { landingExecutionServices } from ${url('landing')};
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
recordGreenRun(${JSON.stringify(greenRun(recorded))}, { runner: ${JSON.stringify(RUNNER)}, files: [${JSON.stringify(FILE)}], timingRunId: ${JSON.stringify(TIMING)} });
const calls = [];
const executionServices = { runners: { ...runnerExecutionServices(),
  probeRunnerTransport: async () => ({ healthy: true }), probeRunnerHealth: async () => ({ healthy: true }), refreshRunnerMeasurements: async () => {},
  trustedTooling: () => ({ tooling: { sha256: ${JSON.stringify(TOOLING)} } }),
  runOnRunnerAsync: async (_root, command, options) => {
    calls.push(command);
    return { isGreen: true, exitCode: 0, output: 'TAP version 13\\nok 1 - ran [C7]\\n', executionRunner: options.runner.host,
      executionSource: { commit: options.source.commit, tree: options.source.tree, tooling: { sha256: ${JSON.stringify(TOOLING)} } } };
  } }, landing: landingExecutionServices() };
const notes = [];
const log = join(process.cwd(), '.git', 'green-gate.log');
const result = await runSubmitGate(process.cwd(), { gate: 'true', affectedTests: ${JSON.stringify(RUNNER)} }, {
  executionServices, staticChecked: true, outputLog: log, onMachineryNote: line => notes.push(line),
  plan: { check: ${JSON.stringify(`${RUNNER} ${FILE}`)}, selection: { full: false, reason: '', files: [] },
    deferred: false, deferFullFallback: false, deferSelection: false, invariants: [], registryGuards: [],
    proofFiles: [], fullConfig: { gate: 'true' }, hasFinalProof: true, phases: [], testTiers: null },
});
process.stdout.write(JSON.stringify({ calls, notes, green: result.isGreen, check: result.check, output: readFileSync(log + '.check.log', 'utf8') }));`;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], { cwd: repo.root, env: repo.env, encoding: 'utf8', timeout: 30_000 }); // budget: one gate with a stub runner.
  assert.equal(child.status, 0, child.context ?? child.stderr);
  return JSON.parse(child.stdout);
}

test('clause 2: the gate\'s item check takes a green pullboard test run of the same files at the same tree, with no runner trip [C7]', t => {
  const run = gateRun(t);
  assert.deepEqual(run.calls, [], 'no runner was asked to run the check again');
  assert.equal(run.green, true);
  assert.equal(run.check.green, true);
  assert.match(run.output, /^# reused green run 11111111-2222-4333-8444-555555555555 /u, 'the check log names the run it reused');
  assert.ok(run.notes.some(line => /item check reused a green pullboard test run/u.test(line)));
});

test('clause 2: a green run at an earlier tree is not reused; the gate runs the check [C7]', t => {
  const run = gateRun(t, { stale: true });
  assert.deepEqual(run.calls, [`${RUNNER} ${FILE}`], 'the check ran on the runner');
  assert.equal(run.check.green, true);
  assert.doesNotMatch(run.output, /reused green run/u);
});
