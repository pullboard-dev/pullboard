/** @pullboard-test-loads packages/gate/src/io/test/tier/selection.js */
/** Tier selection keeps every test for a global change, runs a new tooling test at submit, ignores a project without a path map, and runs the canary at every gate [C7,#4015,#10874]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeTestTiers } from '../../../../index.js';
import { readsDeclared } from '../../../../index.js';
import { testTierReport } from '../../../../index.js';
import { DEFAULT_CANARY } from '../../../../src/io/test/tier/selection.js';
import { submitGatePlan } from '../../../../index.js';
import { fixture as repository } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';
import { frozen } from './frozen.js';
import { change } from './frozen.js';
import { OTHER_TEST } from './frozen.js';
import { MIXED_TEST } from './frozen.js';
import { SIZE_TEST } from './frozen.js';
import { WEB_TEST } from './frozen.js';

test('gate.io-test-tier-selection.a-global-change-keeps-the-tooling: a global change keeps the tooling tier with every other test [C7,#4015]', t => {
  const plan = change(frozen(t), { 'package.json': '{"type":"module","private":true}\n' });
  for (const file of [SIZE_TEST, OTHER_TEST, WEB_TEST]) assert.ok(plan.units.includes(file), `${file} runs: ${plan.units}`);
});

test('gate.io-test-tier-selection.a-tooling-test-the-change-itself: a tooling test the change itself adds runs at submit though no former bin file changed [C7,#4015]', t => {
  const added = 'packages/gate/tests/io/size-new.test.js';
  const plan = change(frozen(t), { [added]: "import { size } from '../../src/io/size.js';\nvoid size;\n" });
  assert.ok(plan.units.includes(added), `the builder's own new test runs: ${plan.units}`);
});

test('gate.io-test-tier-selection.a-project-without-a-layout-path: a project without a layout path map has no tooling tier and selects as before [C7,#4015]', t => {
  const { root, put } = repository(t);
  put('packages/gate/src/io/size.js', 'export const size = 1;\n');
  put(SIZE_TEST, "import { size } from '../../src/io/size.js';\nvoid size;\n");
  writeTestTiers(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const plan = change({ root, put, base: git(root, 'rev-parse', 'HEAD').trim() }, { 'packages/gate/src/io/size.js': 'export const size = 2;\n' });
  assert.ok(plan.units.includes(SIZE_TEST));
});

/** Commit the default canary files (each reaching nothing a change touches) as a new base, with pullboard.json when one is given. */
function withCanary(box, config) {
  for (const file of DEFAULT_CANARY) box.put(file, "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  if (config) box.put('pullboard.json', JSON.stringify(config));
  git(box.root, 'add', '-A');
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'canary');
  return { ...box, base: git(box.root, 'rev-parse', 'HEAD').trim() };
}

test('gate.io-test-tier-selection.a-change-that-reaches-no-canary: clause 1: a change that reaches no canary file still runs the closure budget and stable-ID files at every gate when pullboard.json declares no canary [C7,#10874]', t => {
  const off = change(withCanary(frozen(t), { canary: [] }), { 'packages/web/src/page.js': 'export const page = 2;\n' });
  for (const file of DEFAULT_CANARY) assert.ok(!off.units.includes(file), `the change itself reaches no canary file: ${off.units}`);
  const plan = change(withCanary(frozen(t)), { 'packages/web/src/page.js': 'export const page = 2;\n' });
  for (const file of DEFAULT_CANARY) assert.ok(plan.units.includes(file), `${file} runs: ${plan.units}`);
  for (const file of DEFAULT_CANARY) assert.ok(!plan.journeys.includes(file), `${file} is not left to the batch alone`);
});

test('gate.io-test-tier-selection.a-declared-canary-list-replaces-the: clause 2: a pullboard.json canary list replaces the default, and a listed file the tree lacks is skipped, never refused [C7,#10874]', t => {
  const [budget, stable] = DEFAULT_CANARY;
  const plan = change(withCanary(frozen(t), { canary: [stable, 'packages/gate/tests/io/gone.test.js'] }), { 'packages/web/src/page.js': 'export const page = 2;\n' });
  assert.ok(plan.units.includes(stable), `the declared canary runs: ${plan.units}`);
  assert.ok(!plan.units.includes(budget), 'a default file the list leaves out does not run');
  assert.ok(!plan.units.includes('packages/gate/tests/io/gone.test.js'), 'a listed file the tree lacks is skipped');
});

test('gate.io-test-tier-selection.a-project-with-no-tier: clause 3: a project with no tier manifest gets the canary in the submit gate proof on every submit, deferred or not [C7,#10874]', t => {
  const { root, put } = repository(t);
  for (const file of DEFAULT_CANARY) put(file, "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  put('test/stats.test.js', "import { stats } from '../src/stats.js';\nvoid stats;\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  put('src/stats.js', "export const stats = () => 2;\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
  const commit = git(root, 'rev-parse', 'HEAD').trim();
  for (const submitGate of [undefined, 'landing']) {
    const plan = submitGatePlan(root, { gate: 'true', affectedTests: 'node --test', submitInvariants: [], registryGuards: [], ...(submitGate ? { submitGate } : {}) }, { base, commit });
    assert.equal(plan.testTiers, null, 'the project has no tier manifest');
    for (const file of DEFAULT_CANARY) assert.ok(plan.proofFiles.includes(file), `${submitGate ?? 'immediate'} submit runs ${file}: ${plan.proofFiles}`);
  }
});

test('gate.io-test-tier-selection.no-plan-same-selection: clause 1: selectTestTiers picks the same tests for one source change on a temp tree with and without a plan folder [C7]', t => {
  const source = { 'packages/web/src/page.js': 'export const page = 2;\n' };
  const without = change(frozen(t), source);
  const box = frozen(t);
  change(box, { 'packages/codemap/data/plan/05-web.json': '{"root":"packages/web"}\n' });
  box.base = git(box.root, 'rev-parse', 'HEAD').trim();
  const withPlan = change(box, source);
  assert.deepEqual(withPlan.units, without.units, 'a plan folder in the tree changes no selection');
  assert.ok(withPlan.units.includes(WEB_TEST), `the changed cell's test runs: ${withPlan.units}`);
  assert.ok(!withPlan.units.includes(SIZE_TEST), `an unrelated cell's test stays out: ${withPlan.units}`);
});

const DATA = 'packages/gate/data/ceilings/adapter-lint-fs.json';
const DECLARER = 'packages/gate/tests/io/declares.test.js';
const SCANNER = 'packages/gate/tests/io/scans.test.js';

/** The frozen repository plus a shared ceiling file, one test that declares it, and one that reads the directory at run time, committed as the base. */
function withReaders(t) {
  const box = frozen(t);
  change(box, {
    [DATA]: '{"rows":{}}\n',
    [DECLARER]: `/** @pullboard-test-reads ${DATA} */\nimport { other } from '../../src/io/other.js';\nvoid other;\n`,
    [SCANNER]: "import { readdirSync } from 'node:fs';\nvoid readdirSync('packages/gate/data/ceilings');\nimport { size } from '../../src/io/size.js';\nvoid size;\n",
  });
  return { ...box, base: git(box.root, 'rev-parse', 'HEAD').trim() };
}

test('gate.io-test-tier-selection.shared-data-selects-declared-readers: clause 1: a change of only packages/gate/data/ceilings/adapter-lint-fs.json selects the tests declaring it plus the item\'s own tests and no other T1 test of the package [C7]', t => {
  const plan = change(withReaders(t), { [DATA]: '{"rows":{"a":1}}\n' });
  assert.ok(plan.units.includes(DECLARER), `the declaring test runs: ${plan.units}`);
  assert.ok(plan.units.includes(SCANNER), `the scan finds a directory reader: ${plan.units}`);
  for (const file of [SIZE_TEST, OTHER_TEST, MIXED_TEST]) assert.ok(!plan.units.includes(file), `${file} reads no shared data and stays out: ${plan.units}`);
  assert.deepEqual(plan.sharedData.declared, [DECLARER]);
  assert.deepEqual(plan.sharedData.scan, [SCANNER]);
  assert.match(testTierReport(plan), /1 declared readers, 1 found by the scan/u);
});

test('gate.io-test-tier-selection.shared-data-authored-test-runs: clause 1: a test the data-only change itself adds runs with the declared readers [C7]', t => {
  const added = 'packages/gate/tests/io/own.test.js';
  const plan = change(withReaders(t), { [DATA]: '{"rows":{"b":2}}\n', [added]: "import { size } from '../../src/io/size.js';\nvoid size;\n" });
  assert.ok(plan.units.includes(added), `the item's own test runs: ${plan.units}`);
  assert.ok(plan.units.includes(DECLARER));
  assert.ok(!plan.units.includes(OTHER_TEST));
});

test('gate.io-test-tier-selection.shared-data-no-reader-falls-back: clause 1: a changed data file no test declares and no scan finds keeps every T1 test of the package, never fewer [C7]', t => {
  const plan = change(frozen(t), { 'packages/gate/data/ceilings/adapter-lint-zz.json': '{"rows":{}}\n' });
  for (const file of [SIZE_TEST, OTHER_TEST, MIXED_TEST]) assert.ok(plan.units.includes(file), `${file} runs: ${plan.units}`);
  assert.equal(plan.sharedData, undefined);
});

test('gate.io-test-tier-selection.shared-data-with-code-keeps-package: clause 1: a change that also edits a non-test source file selects as before [C7]', t => {
  const plan = change(withReaders(t), { [DATA]: '{"rows":{"c":3}}\n', 'packages/gate/src/io/other.js': 'export const other = 2;\n' });
  assert.ok(plan.units.includes(OTHER_TEST) && plan.units.includes(MIXED_TEST), `the package's tests run: ${plan.units}`);
  assert.equal(plan.sharedData, undefined);
});

test('gate.io-test-tier-selection.reads-declared-leading-comments-only: clause 1: readsDeclared reads the declaration only from leading comments, one path per line [C7]', t => {
  const { root, put } = repository(t);
  put('packages/gate/tests/a.test.js', '/** @pullboard-test-reads a/one.json */\n// @pullboard-test-reads a/two.json\nimport x from "x";\n');
  put('packages/gate/tests/b.test.js', 'import x from "x";\n// @pullboard-test-reads a/late.json\n');
  const reads = readsDeclared(root, ['packages/gate/tests/a.test.js', 'packages/gate/tests/b.test.js', 'packages/gate/tests/gone.test.js']);
  assert.deepEqual(reads.get('packages/gate/tests/a.test.js'), ['a/one.json', 'a/two.json']);
  assert.deepEqual(reads.get('packages/gate/tests/b.test.js'), []);
  assert.deepEqual(reads.get('packages/gate/tests/gone.test.js'), []);
});
