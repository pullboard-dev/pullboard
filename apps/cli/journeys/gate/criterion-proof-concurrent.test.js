/** @pullboard-test-input source-tree */
/** The frozen criterion starts without the test selection and runs on its own runner beside the proof [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSubmitGate } from '../../../../packages/gate/index.js';
import { startCriterionRun } from '../../../../packages/gate/index.js';
import { runnerExecutionServices } from '../../../../packages/runners/index.js';
import { landingExecutionServices } from '../../../../packages/landing/index.js';
import { gateWithRunnerPlan } from '../../src/io/submit/gate.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../tests/fixtures/testkit.js';

const MAIN = 'a'.repeat(40);
const GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Concurrent', GIT_AUTHOR_EMAIL: 'concurrent@example.invalid',
  GIT_COMMITTER_NAME: 'Concurrent', GIT_COMMITTER_EMAIL: 'concurrent@example.invalid' };
const SLOT_ENV = ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN',
  'PULLBOARD_BROWSER_SLOT_HELD', 'PULLBOARD_LANDING_RUN', 'PULLBOARD_RELEASE_EXECUTORS'];

/**
 * Point this process at a private home and machine, and return the function that puts the previous values back.
 * Why: the gate slot and runner lease queue read their homes from the environment on every call.
 *
 * @param {Record<string, string>} values
 * @returns {() => void}
 */
function privateEnv(values) {
  const keys = [...Object.keys(values), ...SLOT_ENV];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of SLOT_ENV) delete process.env[key];
  Object.assign(process.env, values);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * Run the real gate slot, runner lease queue and runSubmitGate with an injected runner service whose two runs
 * wait for each other, so a serial gate can never finish; return the recorded event order and the result.
 *
 * @param {import('node:test').TestContext} t
 * @param {{early?: boolean, criterion?: 'green'|'red', proof?: 'green'|'red'}} options
 */
async function concurrent(t, { early = false, criterion = 'green', proof = 'green' } = {}) {
  const home = privateFixtureFiles('pullboard-criterion-concurrent-').root;
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, 'repo');
  const machine = join(home, 'machine');
  mkdirSync(root);
  mkdirSync(machine);
  const restore = privateEnv({ PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: machine });
  try {
    fixtureMachineSettings(machine, { gateSlots: 2, browserSlots: 2,
      runners: ['first-runner', 'second-runner'].map(host => ({ host, slots: 1, browser: 1 })),
      gate: { runnersFirst: true, memoryFloorMB: 0, timingRunner: false } });
    writeFileSync(join(root, 'source.txt'), 'committed concurrent source');
    const env = { ...process.env, ...GIT_ENV };
    for (const args of [['init', '-q', '-b', 'main'], ['add', 'source.txt'], ['commit', '-qm', 'test: private concurrent source [C7]']]) runFixtureGit(args, { cwd: root, env });
    const events = [];
    const open = {};
    const opened = new Map();
    /** A promise that resolves when the named run has started. */
    const started = name => opened.get(name) ?? opened.set(name, new Promise(resolve => { open[name] = resolve; })).get(name);
    const other = { check: 'proof', proof: 'check' };
    const green = { isGreen: true, exitCode: 0, output: 'ok' };
    const red = { isGreen: false, exitCode: 1, output: 'TAP version 13\nnot ok 1 - red [C7]\n# fail 1\n' };
    const executionServices = { runners: { ...runnerExecutionServices(),
      probeRunnerTransport: async () => ({ healthy: true }),
      probeRunnerHealth: async () => ({ healthy: true }),
      refreshRunnerMeasurements: async () => {},
      runOnRunnerAsync: async (_root, command, options) => {
        const name = command === 'fixture-check' ? 'check' : 'proof';
        events.push({ name, kind: 'start', host: options.runner.host });
        started(name); open[name]?.();
        await started(other[name]);
        events.push({ name, kind: 'end' });
        return (name === 'check' ? criterion : proof) === 'red' ? red : green;
      } }, landing: landingExecutionServices() };
    const plan = { check: 'fixture-check', selection: { full: false, reason: '', files: ['test/proof.test.js'] },
      deferred: false, deferFullFallback: false, deferSelection: false, invariants: [], registryGuards: [],
      proofFiles: ['test/proof.test.js'], fullConfig: { gate: 'true' }, hasFinalProof: true, phases: [], testTiers: null };
    const config = { gate: 'true', affectedTests: 'fixture-proof' };
    const base = { executionServices, staticChecked: true, outputLog: join(root, '.git', 'concurrent.log') };
    let result;
    if (early) {
      // The runner's selection resolves only after the criterion run has started: waiting for it first would never finish.
      const selection = started('check').then(() => { events.push({ name: 'selection', kind: 'end' }); return { main: MAIN, source: MAIN, plan, admission: { browser: false, gui: false } }; });
      result = await gateWithRunnerPlan(true, selection, { main: MAIN, source: MAIN },
        (runnerPlan, earlyCriterion) => runSubmitGate(root, config, { ...base, ...runnerPlan, earlyCriterion }),
        () => startCriterionRun(root, { check: 'fixture-check', executionServices, outputLog: base.outputLog }));
    } else {
      result = await runSubmitGate(root, config, { ...base, plan });
    }
    return { events, isGreen: result.isGreen, checkGreen: result.check.green, proofGreen: result.completedProof?.isGreen ?? result.isGreen,
      criterionRed: Boolean(result.criterionRed) };
  } finally {
    restore();
  }
}

/** Position of the first event with this name and kind. */
const at = (events, name, kind) => events.findIndex(event => event.name === name && event.kind === kind);

test('clause 1: the criterion run starts before the runner selection finishes, so it never waits for test selection [C7]', { timeout: 120_000 }, async t => {
  const run = await concurrent(t, { early: true });
  assert.ok(at(run.events, 'check', 'start') >= 0, 'the criterion ran');
  assert.ok(at(run.events, 'check', 'start') < at(run.events, 'selection', 'end'), 'the criterion started before selection finished');
  assert.ok(at(run.events, 'selection', 'end') < at(run.events, 'proof', 'start'), 'the proof waited for the selection');
  assert.equal(run.isGreen, true);
});

test('clause 2: criterion and proof run windows overlap on two runners and the result combines both [C7]', { timeout: 120_000 }, async t => {
  for (const early of [false, true]) {
    const green = await concurrent(t, { early });
    const first = Math.min(at(green.events, 'check', 'end'), at(green.events, 'proof', 'end'));
    assert.ok(Math.max(at(green.events, 'check', 'start'), at(green.events, 'proof', 'start')) < first, `both runs were open together (early ${early})`);
    assert.equal(new Set(green.events.filter(event => event.kind === 'start').map(event => event.host)).size, 2, 'each run holds its own runner lease');
    assert.deepEqual([green.isGreen, green.checkGreen], [true, true]);
    const redCriterion = await concurrent(t, { early, criterion: 'red' });
    assert.deepEqual([redCriterion.isGreen, redCriterion.checkGreen, redCriterion.criterionRed], [false, false, true], 'a red criterion is the red result');
    const redProof = await concurrent(t, { early, proof: 'red' });
    assert.deepEqual([redProof.isGreen, redProof.checkGreen, redProof.criterionRed], [false, true, false], 'a green criterion with a red proof is red');
  }
});
