/** @pullboard-test-input source-cell gate */
/** @pullboard-test-loads packages/gate/src/io/test/tier/selection.js */
/** @pullboard-test-loads packages/gate/src/io/test/tier/narrow.js */
/** Tier selection keeps every test for a global change, runs a new tooling test at submit, ignores a project without a path map, and runs the canary at every gate [C7,#4015,#10874]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeTestTiers } from '../../../../heavy.js';
import { readsDeclared } from '../../../../index.js';
import { testTierReport } from '../../../../heavy.js';
import { DEFAULT_CANARY } from '../../../../src/io/test/tier/selection.js';
import { submitGatePlan } from '../../../../heavy.js';
import { selectTestTiers } from '../../../../heavy.js';
import { requireSealedSkips } from '../../../../heavy.js';
import { narrowConfinedTiers } from '../../../../src/io/test/tier/narrow.js';
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

const REGISTRY_TEST = 'packages/alpha/tests/registry.test.js';
const INPUTS_TEST = 'packages/alpha/tests/inputs.test.js';
const STABLE_TEST = 'packages/alpha/tests/stable.test.js';
const RECORD = 'packages/alpha/tests/fixtures/registry-1.json';
const READER_TEST = 'packages/alpha/tests/reads-record.test.js';
const LOADER_TEST = 'packages/alpha/tests/loads-lone.test.js';
const LATE_TEST = 'packages/alpha/tests/late-comment.test.js';

/** The sealed cell plus its registry, inputs and stable tests, a test whose header reads the record, one whose header loads the lone test, and one naming it only after code. */
function recordedCell(t) {
  const box = sealedCell(t);
  const quiet = 'import assert from "node:assert/strict";\nassert.ok(true);\n';
  box.put(REGISTRY_TEST, quiet);
  box.put(INPUTS_TEST, quiet);
  box.put(STABLE_TEST, quiet);
  box.put(RECORD, '{}\n');
  box.put(READER_TEST, `/** @pullboard-test-reads ${RECORD} */\n${quiet}`);
  box.put(LOADER_TEST, `/** @pullboard-test-loads ${LONE_TEST} */\n${quiet}`);
  box.put(LATE_TEST, `${quiet}// @pullboard-test-reads ${RECORD}\n`);
  git(box.root, 'add', '-A');
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'records');
  return { ...box, base: git(box.root, 'rev-parse', 'HEAD').trim() };
}

test('gate.io-test-tier-selection.test-only-change-adds-cell-readers: clause 1: a change of only a cell test and its registry record also selects the cell registry, inputs and stable tests and every test whose header names a changed file, and no other test of the cell [C7]', t => {
  const edit = { [LONE_TEST]: 'import assert from "node:assert/strict";\nassert.ok(2);\n', [RECORD]: '{"a":1}\n' };
  const plan = planWith(recordedCell(t), edit, 'tests').plan;
  for (const file of [LONE_TEST, REGISTRY_TEST, INPUTS_TEST, STABLE_TEST, READER_TEST, LOADER_TEST]) assert.ok(plan.proofFiles.includes(file), `${file} runs: ${plan.proofFiles}`);
  for (const file of [H_TEST, SRC_TEST, LATE_TEST]) assert.ok(!plan.proofFiles.includes(file), `${file} is no reader of the change: ${plan.proofFiles}`);
  assert.deepEqual(plan.owedFiles, [H_TEST, LATE_TEST, SRC_TEST].sort(), 'the rest of the cell is owed to landing');
  const source = planWith(recordedCell(t), { ...edit, 'packages/alpha/src/core/a.js': 'export const a = 4;\n' }, 'tests').plan;
  for (const file of [H_TEST, SRC_TEST, LATE_TEST, REGISTRY_TEST]) assert.ok(source.proofFiles.includes(file), `a product source change keeps ${file}: ${source.proofFiles}`);
  for (const key of [undefined, 'off']) {
    const whole = planWith(recordedCell(t), edit, key).plan;
    for (const file of [H_TEST, SRC_TEST, LATE_TEST]) assert.ok(whole.proofFiles.includes(file), `${key ?? 'absent'} key keeps ${file}: ${whole.proofFiles}`);
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

const READS_TEST = 'packages/alpha/tests/reads-fixture.test.js';
const NAMED_TEST = 'packages/alpha/tests/reads-named.test.js';
const FIXTURE_READ = "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nreadFileSync(join(import.meta.dirname, 'fixtures', 'rows.json'));\n";

/** The sealed cell plus a test that reads a cell fixture no header names, and one that names the same read in a header. */
function readerCell(t) {
  const box = sealedCell(t);
  box.put('packages/alpha/tests/fixtures/rows.json', '{}\n');
  box.put(READS_TEST, FIXTURE_READ);
  box.put(NAMED_TEST, `/** @pullboard-test-input packages/alpha/tests/fixtures/rows.json */\n${FIXTURE_READ}`);
  git(box.root, 'add', '-A');
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'readers');
  return { ...box, base: git(box.root, 'rev-parse', 'HEAD').trim() };
}

test('gate.io-test-tier-selection.test-only-change-keeps-undeclared-readers: clause 1: with confinedImportSelection tests, a test whose read firstUndeclaredRead reports as undeclared is selected when it sits in the narrowed cell or its undeclared read is a path inside it [C7]', t => {
  const edit = { [LONE_TEST]: 'import assert from "node:assert/strict";\nassert.ok(3);\n' };
  const plan = planWith(readerCell(t), edit, 'tests').plan;
  for (const file of [LONE_TEST, READS_TEST]) assert.ok(plan.proofFiles.includes(file), `${file} runs: ${plan.proofFiles}`);
  for (const file of [H_TEST, SRC_TEST, NAMED_TEST]) assert.ok(!plan.proofFiles.includes(file), `${file} declares its reads and imports nothing changed: ${plan.proofFiles}`);
  assert.deepEqual(plan.owedFiles, [H_TEST, NAMED_TEST, SRC_TEST].sort(), 'the declared and importing tests are owed to landing');
  const outside = 'packages/beta/tests/reads-alpha.test.js';
  const tiers = { units: [LONE_TEST, outside, 'packages/beta/tests/plain.test.js'], confinedRoots: ['packages/alpha', 'packages/beta'], changed: [LONE_TEST] };
  const sources = { [outside]: "import { readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nreadFileSync(join(import.meta.dirname, '../../alpha/tests/fixtures/rows.json'));\n", 'packages/beta/tests/plain.test.js': 'void 0;\n' };
  const narrowed = narrowConfinedTiers(tiers, { mode: 'tests', select: () => ({ files: [] }), read: file => sources[file] ?? null });
  assert.deepEqual(narrowed.units, [LONE_TEST, outside], 'a test of another cell whose undeclared read is inside the changed cell is kept, a plain one is dropped');
  for (const key of [undefined, 'off']) {
    const whole = planWith(readerCell(t), edit, key).plan;
    for (const file of [H_TEST, SRC_TEST, NAMED_TEST, READS_TEST]) assert.ok(whole.proofFiles.includes(file), `${key ?? 'absent'} key keeps ${file}: ${whole.proofFiles}`);
  }
});

test('gate.io-test-tier-selection.test-only-change-keeps-undeclared-readers-real-path: clause 2: submitGatePlan with confinedImportSelection tests plans fewer than 30 proof files for the landed diff of #11202 and every cell test for a one-line product source edit, and the setting off equals the absent key [C7]', t => {
  const root = git(import.meta.dirname, 'rev-parse', '--show-toplevel').trim();
  const commit = '76035f0c70';
  const base = git(root, 'rev-parse', `${commit}^1`).trim();
  const plan = key => submitGatePlan(root, { ...NARROW_CONFIG, ...(key === undefined ? {} : { confinedImportSelection: key }) }, { base, commit: git(root, 'rev-parse', commit).trim() });
  const narrowed = plan('tests');
  assert.ok(narrowed.proofFiles.length < 30, `fewer than 30 proof files: ${narrowed.proofFiles.length}: ${narrowed.proofFiles.slice(0, 40)}`);
  for (const file of ['apps/cli/journeys/gate/slot.test.js', 'apps/cli/tests/stable.test.js']) assert.ok(narrowed.proofFiles.includes(file), `${file} is planned: ${narrowed.proofFiles}`);
  assert.deepEqual(plan('off').proofFiles, plan().proofFiles, 'with the setting off the proof files equal the absent key');
  const box = readerCell(t);
  const source = planWith(box, { 'packages/alpha/src/core/a.js': 'export const a = 2;\n' }, 'tests').plan;
  for (const file of [...CELL_TESTS, READS_TEST, NAMED_TEST]) assert.ok(source.proofFiles.includes(file), `a product source line keeps ${file}: ${source.proofFiles}`);
});
