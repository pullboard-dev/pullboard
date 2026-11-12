/** Submit and landing select only unsealed packages' tests plus contracts at changed front doors (RFC 0006 A3) [C7,CD44]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import { test } from 'node:test';
import {
  CLEAN_GATES_TO_ENFORCE,
  countTrialGate,
  recordSeal,
  requireSealedSkips,
  refusalMode,
  runMachineryGuard,
  runSubmitGate,
  submitGatePlan,
  sealStatus,
  sealStoreFile,
  selectTestTiers,
  testTierReport,
  writeTestTiers,
} from '../../../../../packages/gate/index.js';
import { runFixtureGit } from '../../fixtures/child.js';
import { namedProofTests } from '../../../src/io/submit.js';
import { executionServices } from '../../fixtures/gate/execution.js';

const IDENTITY = ['-c', 'user.name=Seal Test', '-c', 'user.email=seal@example.test', '-c', 'commit.gpgsign=false'];
const BASE_TEST = 'packages/base/tests/base.test.js';
const CONTRACT = 'packages/base/contract/user.test.js';
const USER_TEST = 'packages/user/tests/user.test.js';

/** Write files into a private repository and commit them, returning the new commit id. */
function commit(root, files) {
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  runFixtureGit(['add', '-A'], { cwd: root });
  runFixtureGit([...IDENTITY, 'commit', '-q', '-m', 'change'], { cwd: root });
  return runFixtureGit(['rev-parse', 'HEAD'], { cwd: root });
}

/**
 * base is imported by user; alone imports nothing. base carries a consumer contract that opens a board (so it is never
 * a plain unit), user's own test crosses into base, and one root journey spans packages. Candidate tests never run here.
 */
function fixture(t, { unsealed = [], tiers = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-seal-selection-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q'], { cwd: root });
  const files = {
    'package.json': '{"type":"module"}\n',
    'packages/base/index.js': 'export { add } from "./src/core/add.js";\n',
    'packages/base/src/core/add.js': 'export const add = (a, b) => a + b;\n',
    [BASE_TEST]: 'import { add } from "../index.js";\nadd(1, 2);\n',
    [CONTRACT]: 'import { add } from "../index.js";\nfake.openBoard(":memory:");\nadd(1, 2);\n',
    'packages/user/index.js': 'export { total } from "./src/core/total.js";\n',
    'packages/user/src/core/total.js': 'import { add } from "../../../base/index.js";\nexport const total = rows => rows.reduce(add, 0);\n',
    [USER_TEST]: 'import { total } from "../index.js";\ntotal([1]);\n',
    'packages/alone/index.js': 'export const alone = 1;\n',
    'packages/alone/tests/alone.test.js': 'import { alone } from "../index.js";\nvoid alone;\n',
    'test/journey.test.js': 'import "../packages/alone/index.js";\nimport "../packages/user/index.js";\nimport { spawnSync } from "node:child_process";\nspawnSync("git");\n',
  };
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  if (tiers) writeTestTiers(root);
  const first = commit(root, {});
  if (!tiers) return { root, first };
  const store = sealStoreFile(root);
  for (const row of sealStatus(root, { rev: first, store })) if (!unsealed.includes(row.package)) recordSeal(store, { package: row.package, hash: row.hash, receipts: [`receipt-${row.package.replace('packages/', '')}`], tests: [] });
  return { root, first };
}

test('a change inside one package runs only that package\'s tests and skips sealed packages by receipt [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  assert.deepEqual(plan.units, [BASE_TEST]);
  assert.deepEqual(plan.skipped, [{ package: 'packages/alone', hash: plan.skipped[0].hash, receipt: 'receipt-alone' }]);
  assert.ok(plan.journeys.includes(CONTRACT) && plan.journeys.includes(USER_TEST), 'an unchanged front door runs no contract and no importer');
  assert.match(testTierReport(plan), /^Sealed packages skipped \(1\): packages\/alone by receipt receipt-alone$/mu);
  assert.doesNotThrow(() => requireSealedSkips(root, plan));
});

test('a changed front door runs its contracts and unseals and runs its importers [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/index.js': 'export { add } from "./src/core/add.js";\nexport const zero = 0;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  assert.deepEqual(plan.units, [CONTRACT, BASE_TEST, USER_TEST]);
  assert.ok(plan.packages.includes('packages/user'));
  assert.deepEqual(plan.skipped.map(row => [row.package, row.receipt]), [['packages/alone', 'receipt-alone']]);
  assert.deepEqual(plan.journeys, ['test/journey.test.js'], 'journeys wait for the landing batch');
});

test('control: a plan that hides a real change from its run fails, so skip logic never reports a false green [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/index.js': 'export { add } from "./src/core/add.js";\nexport const one = 1;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  const hidden = { ...plan, units: plan.units.filter(file => file !== USER_TEST), skipped: [...plan.skipped, { package: 'packages/user', hash: null, receipt: 'receipt-user' }] };
  assert.throws(() => requireSealedSkips(root, hidden), { code: 'SEAL_STALE', message: /packages\/user/u });
  assert.throws(() => requireSealedSkips(root, { ...plan, base: null }), { code: 'SEAL_STALE' });
});

test('control: the real submit path refuses a unit or front-door contract dropped from both units and skipped, and one missing from the run [C7,CD44]', async t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/index.js': 'export { add } from "./src/core/add.js";\nexport const two = 2;\n' });
  const config = { gate: 'true', affectedTests: 'node --test', submitInvariants: [], registryGuards: [] };
  const plan = submitGatePlan(root, config, { base: first });
  assert.equal(plan.testTiers.commit, head);
  assert.ok(plan.testTiers.units.includes(USER_TEST) && plan.proofFiles.includes(USER_TEST), 'the real selection runs the importer');
  assert.doesNotThrow(() => requireSealedSkips(root, plan.testTiers, { proofFiles: plan.proofFiles, check: plan.check }));
  await assert.doesNotReject(runSubmitGate(root, config, { base: first, check: plan.check, plan, staticChecked: true, executionServices }),
    'the complete selection is accepted by the real submit path');
  const dropped = { ...plan, proofFiles: plan.proofFiles.filter(file => file !== USER_TEST),
    testTiers: { ...plan.testTiers, units: plan.testTiers.units.filter(file => file !== USER_TEST) } };
  assert.deepEqual(dropped.testTiers.skipped, plan.testTiers.skipped, 'nothing is added to skipped');
  await runMachineryGuard(root, () => requireSealedSkips(root, dropped.testTiers, { proofFiles: dropped.proofFiles, check: dropped.check }),
    { kind: 'selection', rule: requireSealedSkips.toString(), say() {} });
  for (let gate = 0; gate < CLEAN_GATES_TO_ENFORCE; gate++) countTrialGate(root, { id: `selection-control-${gate}` });
  assert.deepEqual(refusalMode(root, 'TEST_SELECTION_INCOMPLETE', { rule: ['selection', requireSealedSkips.toString()] }),
    { mode: 'enforce', clean: CLEAN_GATES_TO_ENFORCE }, 'the isolated selection guard has completed its report-only trial');
  await assert.rejects(runSubmitGate(root, config, { base: first, check: plan.check, plan: dropped, staticChecked: true, executionServices }),
    { code: 'TEST_SELECTION_INCOMPLETE', message: /neither selected nor skipped: packages\/user\/tests\/user\.test\.js/u });
  const unrun = { ...plan, proofFiles: plan.proofFiles.filter(file => file !== USER_TEST) };
  await assert.rejects(runSubmitGate(root, config, { base: first, check: plan.check, plan: unrun, staticChecked: true, executionServices }),
    { code: 'TEST_SELECTION_INCOMPLETE', message: /missing from the submit run: packages\/user\/tests\/user\.test\.js/u });
  assert.ok(plan.testTiers.units.includes(CONTRACT) && plan.proofFiles.includes(CONTRACT), 'the real selection runs the changed front door contract');
  const noContract = { ...plan, proofFiles: plan.proofFiles.filter(file => file !== CONTRACT),
    testTiers: { ...plan.testTiers, units: plan.testTiers.units.filter(file => file !== CONTRACT) } };
  assert.deepEqual(noContract.testTiers.skipped, plan.testTiers.skipped, 'nothing is added to skipped');
  await assert.rejects(runSubmitGate(root, config, { base: first, check: plan.check, plan: noContract, staticChecked: true, executionServices }),
    { code: 'TEST_SELECTION_INCOMPLETE', message: /neither selected nor skipped: packages\/base\/contract\/user\.test\.js/u });
});

test('an unchanged package with no current seal runs its tests, and a skip without a current seal receipt refuses [C7,CD44]', t => {
  const { root, first } = fixture(t, { unsealed: ['packages/alone'] });
  const head = commit(root, { 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  assert.deepEqual(plan.units, ['packages/alone/tests/alone.test.js', BASE_TEST]);
  assert.ok(plan.packages.includes('packages/alone'));
  assert.deepEqual(plan.skipped, []);
  assert.doesNotThrow(() => requireSealedSkips(root, plan));
  const forged = { ...plan, units: [BASE_TEST], skipped: [{ package: 'packages/alone', hash: null, receipt: null }] };
  assert.throws(() => requireSealedSkips(root, forged), { code: 'SEAL_STALE', message: /packages\/alone/u });
  const borrowed = { ...forged, skipped: [{ package: 'packages/alone', hash: null, receipt: 'receipt-base' }] };
  assert.throws(() => requireSealedSkips(root, borrowed), { code: 'SEAL_STALE', message: /packages\/alone/u });
});

test('a sealed skip must cite a receipt its current seal holds [C7,CD44]', t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  const plan = selectTestTiers(root, { base: first, commit: head });
  const swapped = { ...plan, skipped: plan.skipped.map(row => ({ ...row, receipt: 'receipt-base' })) };
  assert.throws(() => requireSealedSkips(root, swapped), { code: 'SEAL_STALE', message: /packages\/alone/u });
});

test('clause 1: the real gate-submit path runs a test file the bar names in a sealed package the change never reaches [C7,V4]', async t => {
  const { root, first } = fixture(t);
  const head = commit(root, { 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  const ALONE_TEST = 'packages/alone/tests/alone.test.js';
  const config = { gate: 'true', affectedTests: 'node --test', submitInvariants: [], registryGuards: [] };
  const sealed = submitGatePlan(root, config, { base: first });
  assert.ok(sealed.testTiers.skipped.some(row => row.package === 'packages/alone') && !sealed.proofFiles.includes(ALONE_TEST),
    'sealing alone skips the named file');
  const item = { item_frozen: JSON.stringify({ criterion: `1. The alone package still loads, proved by ${ALONE_TEST} [test].` }),
    item_brief: 'Files: packages/base\nTest:\n- test/journey.test.js\n- test/missing.test.js' };
  const crossRunTests = namedProofTests(root, item, head);
  assert.deepEqual(crossRunTests, [ALONE_TEST, 'test/journey.test.js'], 'criterion and brief files that exist at the commit');
  const plan = submitGatePlan(root, config, { base: first, crossRunTests });
  assert.ok(plan.proofFiles.includes(ALONE_TEST) && plan.proofFiles.includes('test/journey.test.js'), `the gate runs both: ${plan.proofFiles}`);
  const proof = await runSubmitGate(root, config, { base: first, check: plan.check, plan, crossRunTests, staticChecked: true, executionServices });
  assert.ok(proof.files.includes(ALONE_TEST) && proof.files.includes('test/journey.test.js'), `the recorded proof names both files: ${JSON.stringify(proof.files)}`);
});

test('clause 1: with no affected-tests runner configured, the bar-named files still join the proof selection and the real gate-submit path runs them [C7,V4]', async t => {
  const { root, first } = fixture(t, { tiers: false });
  const ALONE_TEST = 'packages/alone/tests/alone.test.js';
  const head = commit(root, { 'packages/base/src/core/add.js': 'export const add = (a, b) => b + a;\n' });
  const item = { item_frozen: JSON.stringify({ criterion: `1. The alone package still loads, proved by ${ALONE_TEST} [test].` }),
    item_brief: 'Files: packages/base\nTest:\n- test/journey.test.js\n- test/missing.test.js' };
  const crossRunTests = namedProofTests(root, item, head);
  assert.deepEqual(crossRunTests, [ALONE_TEST, 'test/journey.test.js'], 'no runner: the criterion and brief files that exist at the commit');
  // A landing-deferred project with no runner: no tier plan, so only the named files are the submit proof.
  const config = { gate: 'false', submitGate: 'landing', submitInvariants: [], registryGuards: [] };
  const plan = submitGatePlan(root, config, { base: first, crossRunTests });
  assert.equal(plan.testTiers, null, 'the fixture has no tier plan');
  assert.deepEqual(plan.proofFiles, [ALONE_TEST, 'test/journey.test.js'], `the proof selection names both: ${plan.proofFiles}`);
  assert.equal(plan.proofCommand, `node --test './${ALONE_TEST}' './test/journey.test.js'`, 'Node runs the named files');
  const proof = await runSubmitGate(root, config, { base: first, check: plan.check, plan, crossRunTests, staticChecked: true, executionServices });
  assert.ok(proof.isGreen, `the named files ran green: ${proof.output}`);
  assert.ok(proof.files.includes(ALONE_TEST) && proof.files.includes('test/journey.test.js'), `the recorded proof names both files: ${JSON.stringify(proof.files)}`);
});
