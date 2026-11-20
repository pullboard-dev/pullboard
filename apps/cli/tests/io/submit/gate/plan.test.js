/** A handoff worker takes the runner's test plan as given and refuses one that does not bind or cover the submit [C7,H24]. */
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  acceptRunnerPlan,
  gateWithRunnerPlan,
  runSubmitGateWithRunnerPlan,
} from '../../../../src/io/submit/gate.js';
import {
  runSubmitGate,
  submitGateAdmission,
  submitGatePlan,
} from '../../../../../../packages/gate/heavy.js';
import { executionServices } from '../../../fixtures/gate/execution.js';
import { runFixtureGit } from '../../../fixtures/child.js';

const main = 'a'.repeat(40);
const source = 'b'.repeat(40);
const analysis = { main, source, plan: { proofFiles: ['test/a.test.js', 'test/b.test.js'] }, admission: { browser: false, gui: false } };
const IDENTITY = ['-c', 'user.name=Plan Test', '-c', 'user.email=plan@example.test', '-c', 'commit.gpgsign=false'];

/** Commit the given files into a private repository and return the new commit id. */
function commit(root, files) {
  for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
  runFixtureGit(['add', '-A'], { cwd: root });
  runFixtureGit([...IDENTITY, 'commit', '-q', '-m', 'change'], { cwd: root });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
}

/** A two-commit repository whose change selects one passing test. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-runner-plan-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q'], { cwd: root });
  const base = commit(root, { 'package.json': '{"type":"module"}\n', 'add.js': 'export const add = (a, b) => a + b;\n',
    'add.test.js': 'import { add } from "./add.js";\nif (add(1, 2) !== 3) throw new Error("add");\n' });
  commit(root, { 'add.js': 'export const add = (a, b) => b + a;\n' });
  return { root, base };
}

const config = { gate: 'true', affectedTests: 'node --test', submitInvariants: [], registryGuards: [] };
/** Planners that fail the test if the controller ever plans or admits on its own. */
const forbidden = { plan: () => assert.fail('the Mac planned the selection'), admission: () => assert.fail('the Mac ran browser admission') };

test('cli.io-submit-gate-plan.a-runner-plan-bound-to-the-pinned: a runner plan bound to the pinned commits is used with its admission, so the Mac plans nothing [C7,H24]', () => {
  assert.deepEqual(acceptRunnerPlan(analysis, { main, source, crossRunTests: ['test/b.test.js'] }), { plan: analysis.plan, admission: analysis.admission });
});

test('cli.io-submit-gate-plan.a-plan-that-leaves-out-a-call: clause 1: a plan that leaves out a call-adjacent file the frozen check already runs completely is accepted [C7,H24]', () => {
  const check = 'node apps/cli/src/io/run/tests.js test/c.test.js';
  assert.deepEqual(acceptRunnerPlan(analysis, { main, source, crossRunTests: ['test/c.test.js'], check }), { plan: analysis.plan, admission: analysis.admission });
});

test('cli.io-submit-gate-plan.a-plan-that-leaves-out-a-call-2: clause 2: a plan that leaves out a call-adjacent file the check does not run completely is still refused [C7,H24]', () => {
  const filtered = 'node apps/cli/src/io/run/tests.js test/c.test.js --test-name-pattern x';
  assert.throws(() => acceptRunnerPlan(analysis, { main, source, crossRunTests: ['test/c.test.js'], check: filtered }), { code: 'RUNNER_RESULT_INVALID', message: /test\/c\.test\.js/u });
  assert.throws(() => acceptRunnerPlan(analysis, { main, source, crossRunTests: ['test/c.test.js'], check: 'node tests.js test/d.test.js' }), { code: 'RUNNER_RESULT_INVALID' });
});

test('cli.io-submit-gate-plan.submit-passes-the-accepted-runner-plan-and: clause 1: submit passes the accepted runner plan and admission to runSubmitGate without invoking local planning [C7,H24]', () => {
  let received;
  const runSubmitGate = (root, config, options) => { received = { root, config, options }; return 'gate'; };
  const runnerPlan = acceptRunnerPlan(analysis, { main, source, crossRunTests: ['test/b.test.js'] });
  const result = runSubmitGateWithRunnerPlan(runSubmitGate, '/controller', { affectedTests: true }, runnerPlan, { staticChecked: true });
  assert.equal(result, 'gate');
  assert.equal(typeof received.options.tableReplay, 'function', 'the move-table replay is wired in [#8117]');
  assert.match(received.options.timedShell, /apps\/runner\/src\/io\/shell\.js$/u, 'the timed shell entry reaches runSubmitGate [#6905]');
  delete received.options.tableReplay;
  delete received.options.timedShell;
  assert.deepEqual(received, { root: '/controller', config: { affectedTests: true }, options: {
    staticChecked: true, plan: analysis.plan, admission: analysis.admission,
  } });
});

test('cli.io-submit-gate-plan.a-runner-plan-whose-main-or-source: clause 2: a runner plan whose main or source differs refuses RUNNER_RESULT_INVALID [C7,H24]', () => {
  for (const other of [{ ...analysis, main: 'c'.repeat(40) }, { ...analysis, source: 'c'.repeat(40) }]) {
    assert.throws(() => acceptRunnerPlan(other, { main, source }), { code: 'RUNNER_RESULT_INVALID' });
  }
});

test('cli.io-submit-gate-plan.a-runner-plan-missing-prooffiles-or-a: clause 3: a runner plan missing proofFiles or a call-adjacent test refuses instead of running a smaller selection [C7,H24]', () => {
  assert.throws(() => acceptRunnerPlan({ ...analysis, plan: {} }, { main, source }), { code: 'RUNNER_RESULT_INVALID' });
  assert.throws(() => acceptRunnerPlan(analysis, { main, source, crossRunTests: ['test/c.test.js'] }), { code: 'RUNNER_RESULT_INVALID', message: /test\/c\.test\.js/u });
});

test('cli.io-submit-gate-plan.a-runner-plan-with-no-browser-and: a runner plan with no browser and GUI admission refuses as infrastructure instead of admitting on the Mac [C7,H24]', () => {
  for (const admission of [undefined, null, {}, { browser: false }, { browser: 'no', gui: false }]) {
    assert.throws(() => acceptRunnerPlan({ ...analysis, admission }, { main, source }), { code: 'RUNNER_RESULT_INVALID', message: /admission/u });
  }
});

test('cli.io-submit-gate-plan.a-refused-runner-plan-never-starts-the: a refused runner plan never starts the gate, so it records no proof [C7,H24]', async () => {
  let started = 0;
  const runGate = async () => { started++; return { proofReceiptIds: ['should-not-exist'] }; };
  for (const bad of [{ ...analysis, main: 'c'.repeat(40) }, { ...analysis, plan: {} }, { ...analysis, admission: undefined }]) {
    await assert.rejects(gateWithRunnerPlan(true, Promise.resolve(bad), { main, source }, runGate), { code: 'RUNNER_RESULT_INVALID' });
  }
  await assert.rejects(gateWithRunnerPlan(true, Promise.reject(Object.assign(new Error('selection failed'), { code: 'RUNNER_UNAVAILABLE' })), { main, source }, runGate),
    { code: 'RUNNER_UNAVAILABLE' });
  assert.equal(started, 0);
});

test('cli.io-submit-gate-plan.in-remote-mode-the-runner-plan-and: in remote mode the runner plan and admission reach runSubmitGate, which never plans or admits on the Mac [C7,H24]', async t => {
  const { root, base } = fixture(t);
  const runnerPlan = submitGatePlan(root, config, { base });
  const runnerAdmission = await submitGateAdmission(root, runnerPlan, { allowBrowserFreeChecks: true });
  const head = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
  const selection = Promise.resolve({ main, source: head, plan: runnerPlan, admission: runnerAdmission });
  let given;
  const gate = await gateWithRunnerPlan(true, selection, { main, source: head }, options => {
    given = options;
    return runSubmitGate(root, config, { ...options, base, check: runnerPlan.check, staticChecked: true, executionServices, planners: forbidden });
  });
  assert.deepEqual(given, { plan: runnerPlan, admission: runnerAdmission });
  assert.equal(gate.isGreen, true, gate.output);
  assert.deepEqual(gate.files, runnerPlan.proofFiles);
  assert.ok(gate.files.includes("add.test.js"), "the runner plan selected the changed test");
});

test('cli.io-submit-gate-plan.a-foreground-submit-with-no-handoff-still: clause 4: a foreground submit with no handoff still plans and admits locally with an unchanged result [C7,H24]', async t => {
  const { root, base } = fixture(t);
  const expected = submitGatePlan(root, config, { base });
  const calls = { plan: 0, admission: 0 };
  const counting = { plan: (...args) => { calls.plan++; return submitGatePlan(...args); },
    admission: (...args) => { calls.admission++; return submitGateAdmission(...args); } };
  let given;
  const never = new Promise(() => {});
  const gate = await gateWithRunnerPlan(false, never, { main, source }, options => {
    given = options;
    return runSubmitGate(root, config, { ...options, base, check: expected.check, staticChecked: true, executionServices, planners: counting });
  });
  assert.deepEqual(given, {});
  assert.deepEqual(calls, { plan: 1, admission: 1 });
  assert.equal(gate.isGreen, true, gate.output);
  assert.deepEqual(gate.files, expected.proofFiles);
});
