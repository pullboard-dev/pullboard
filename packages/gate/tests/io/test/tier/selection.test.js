/** @pullboard-test-loads packages/gate/src/io/test/tier/selection.js */
/** @pullboard-test-loads packages/gate/src/io/test/tier/narrow.js */
/** Tier selection keeps every test for a global change, runs a new tooling test at submit, ignores a project without a path map, and runs the canary at every gate [C7,#4015,#10874]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeTestTiers } from '../../../../index.js';
import { toolingTests } from '../../../../src/io/test/tier/selection.js';
import { DEFAULT_CANARY } from '../../../../src/io/test/tier/selection.js';
import { submitGatePlan } from '../../../../index.js';
import { selectTestTiers } from '../../../../index.js';
import { requireSealedSkips } from '../../../../index.js';
import { narrowConfinedTiers } from '../../../../src/io/test/tier/narrow.js';
import { fixture as repository } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';
import { frozen } from './frozen.js';
import { change } from './frozen.js';
import { OTHER_TEST } from './frozen.js';
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
  assert.ok(!plan.units.includes(SIZE_TEST), 'the unchanged tooling test stays out');
});

test('gate.io-test-tier-selection.a-project-without-a-layout-path: a project without a layout path map has no tooling tier and selects as before [C7,#4015]', t => {
  const { root, put } = repository(t);
  put('packages/gate/src/io/size.js', 'export const size = 1;\n');
  put(SIZE_TEST, "import { size } from '../../src/io/size.js';\nvoid size;\n");
  writeTestTiers(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const plan = change({ root, put, base: git(root, 'rev-parse', 'HEAD').trim() }, { 'packages/gate/src/io/size.js': 'export const size = 2;\n' });
  assert.deepEqual(toolingTests(root, 'HEAD'), []);
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

const H_TEST = 'packages/alpha/tests/uses-helper.test.js';
const SRC_TEST = 'packages/alpha/tests/uses-source.test.js';
const LONE_TEST = 'packages/alpha/tests/alone.test.js';
const HELPER = 'packages/alpha/tests/helpers/h.js';
const CELL_TESTS = [LONE_TEST, SRC_TEST, H_TEST];
const NARROW_CONFIG = { gate: 'true', affectedTests: 'node --test', submitInvariants: [], registryGuards: [] };

/** A sealed cell with three tests: one imports a test helper, one the cell's source, one nothing; the canary files ride at main. */
function sealedCell(t) {
  const { root, put } = repository(t);
  const listing = { version: 1, journeys: {}, pureHelpers: {}, leaves: [], findings: {}, rootTests: 0, sealed: ['alpha'], splits: {} };
  put('package.json', '{"type":"module"}\n');
  put('packages/alpha/index.js', 'export { a } from "./src/core/a.js";\n');
  put('packages/alpha/src/core/a.js', 'export const a = 1;\n');
  put('packages/alpha/data/rows.json', '{"rows":1}\n');
  put(HELPER, 'export const h = 1;\n');
  put(H_TEST, 'import { h } from "./helpers/h.js";\nvoid h;\n');
  put(SRC_TEST, 'import { a } from "../index.js";\nvoid a;\n');
  put(LONE_TEST, 'import assert from "node:assert/strict";\nassert.ok(true);\n');
  for (const file of DEFAULT_CANARY) put(file, "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  put('packages/gate/data/tests/test-cells.json', JSON.stringify(listing));
  put('packages/gate/data/ceilings/cells-edges.json', JSON.stringify({ files: { 'packages/alpha/src/core/a.js': { cells: 0, deep: 0 } }, cells: { alpha: { imports: [], deepImporters: 0 } } }));
  put('packages/codemap/data/plan/01-alpha.json', JSON.stringify({ order: 1, name: 'alpha', kind: 'package', root: 'packages/alpha', frontDoor: 'packages/alpha/index.js', paths: [['src/a.js', 'packages/alpha/src/core/a.js', 'seed']] }));
  git(root, 'add', '-A');
  writeTestTiers(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return { root, put, base: git(root, 'rev-parse', 'HEAD').trim() };
}

/** Commit edits to the sealed cell's existing files, and plan the submit gate with the repo key given. */
function planWith(box, edits, key) {
  for (const [file, source] of Object.entries(edits)) box.put(file, source);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'change');
  const commit = git(box.root, 'rev-parse', 'HEAD').trim();
  const config = { ...NARROW_CONFIG, ...(key === undefined ? {} : { confinedImportSelection: key }) };
  return { commit, plan: submitGatePlan(box.root, config, { base: box.base, commit }) };
}

test('gate.io-test-tier-selection.confined-import-narrows-tests: clause 1: a test helper edit under tests plans only its importer and the canary, and the key absent or off plans all three [C7]', t => {
  const box = sealedCell(t);
  const edit = { [HELPER]: 'export const h = 2;\n' };
  const narrowed = planWith(box, edit, 'tests').plan;
  assert.deepEqual(narrowed.proofFiles, [...DEFAULT_CANARY, H_TEST].sort(), `only the helper's importer and the canary: ${narrowed.proofFiles}`);
  const own = planWith(sealedCell(t), { [LONE_TEST]: 'import assert from "node:assert/strict";\nassert.ok(1);\n' }, 'tests').plan;
  assert.ok(own.proofFiles.includes(LONE_TEST), 'a changed test stays');
  assert.ok(!own.proofFiles.includes(H_TEST) && !own.proofFiles.includes(SRC_TEST), 'tests that reach nothing changed are dropped');
  for (const key of [undefined, 'off']) {
    const whole = planWith(sealedCell(t), edit, key).plan;
    for (const file of CELL_TESTS) assert.ok(whole.proofFiles.includes(file), `${key ?? 'absent'} key keeps ${file}: ${whole.proofFiles}`);
  }
});

test('gate.io-test-tier-selection.confined-import-fails-closed: clause 2: a cell source edit, a data file outside tests and a full or thrown selection keep the whole cell tests folder, and all drops what no import reaches [C7]', t => {
  for (const edit of [{ 'packages/alpha/src/core/a.js': 'export const a = 2;\n' }, { 'packages/alpha/data/rows.json': '{"rows":2}\n' }]) {
    const plan = planWith(sealedCell(t), edit, 'tests').plan;
    for (const file of CELL_TESTS) assert.ok(plan.proofFiles.includes(file), `${Object.keys(edit)[0]} keeps ${file} under tests: ${plan.proofFiles}`);
    assert.equal(plan.owedFiles, undefined, 'nothing is owed when nothing narrowed');
  }
  const wide = planWith(sealedCell(t), { 'packages/alpha/src/core/a.js': 'export const a = 3;\n' }, 'all').plan;
  assert.ok(wide.proofFiles.includes(SRC_TEST), 'under all a source change keeps the test importing it');
  assert.ok(!wide.proofFiles.includes(LONE_TEST) && !wide.proofFiles.includes(H_TEST), 'under all a test no import reaches is dropped');
  const tiers = { units: [...CELL_TESTS], confinedRoots: ['packages/alpha'], changed: [HELPER] };
  assert.equal(narrowConfinedTiers(tiers, { mode: 'tests', select: () => ({ full: true, files: [] }) }), null, 'a full selection keeps the folder');
  assert.equal(narrowConfinedTiers(tiers, { mode: 'tests', select: () => { throw new Error('graph'); } }), null, 'a thrown selection keeps the folder');
  assert.equal(narrowConfinedTiers({ units: [...CELL_TESTS], changed: [HELPER] }, { mode: 'tests', select: () => ({ files: [H_TEST] }) }), null, 'an unconfined change keeps its units');
});

test('gate.io-test-tier-selection.narrowed-gate-not-landing-proof: clause 2: a narrowed gate names the cell tests it dropped as owed, and the landing plan on the merged tree holds all three [C7]', t => {
  const box = sealedCell(t);
  const { commit, plan } = planWith(box, { [HELPER]: 'export const h = 3;\n' }, 'tests');
  assert.deepEqual(plan.owedFiles, [LONE_TEST, SRC_TEST], 'the dropped cell tests ride as owed files for landing');
  assert.doesNotThrow(() => requireSealedSkips(box.root, plan.testTiers, { proofFiles: plan.proofFiles }), 'the completeness guard accepts owed files');
  const landing = selectTestTiers(box.root, { base: box.base, commit });
  for (const file of CELL_TESTS) assert.ok(landing.units.includes(file), `landing selects ${file} on the exact tree: ${landing.units}`);
});
