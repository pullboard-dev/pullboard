/** A change inside sealed cells shrinks the gate: apps cells confine, and so do the listing rows that ride with them (#4633) [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireSealedSkips } from '../index.js';
import { selectTestTiers } from '../index.js';
import { submitGatePlan } from '../index.js';
import { writeTestTiers } from '../index.js';
import { fixture as repository } from '../../landing/tests/fixtures/plan.js';
import { git } from '../../landing/tests/fixtures/plan.js';

const TIERS = 'packages/gate/data/tests/tiers.json';
const ALPHA_TEST = 'packages/alpha/tests/a.test.js';
const GAMMA_TEST = 'apps/gamma/tests/g.test.js';
const LINTS_TEST = 'test/cell-lints.test.js';

const writers = new Map();

/** Write one file into a private repository through the fixture that owns its root; a listing is written as JSON. */
function put(root, file, source) { writers.get(root)(file, typeof source === 'string' ? source : JSON.stringify(source, null, 1) + '\n'); }

/** Write files into a private repository and commit them, returning the new commit id. */
function commit(root, files) {
  for (const [file, source] of Object.entries(files)) put(root, file, source);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
  return git(root, 'rev-parse', 'HEAD').trim();
}

/** The test-cell listing, with the cells it records as sealed. */
const listing = (sealed, extra = {}) => ({ version: 1, journeys: {}, pureHelpers: {}, leaves: [], findings: {}, rootTests: 2, sealed, splits: {}, ...extra });
/** One shard of the cells plan, for a cell and the paths it holds. */
const shard = (order, name, root, paths) => ({ order, name, kind: 'package', root, frontDoor: `${root}/index.js`, paths });
/** The edge ceilings of a cell and of its files. */
const edges = (files, cells) => ({ files, cells });

/**
 * Two package cells (alpha sealed, beta open) and one apps cell (gamma, sealed), a root journey, and a root test of the
 * cell lints that names the cells plan. Everything is committed with its listings, as main carries them.
 */
function fixture(t, sealed = ['alpha', 'apps/gamma']) {
  const { root, put: write } = repository(t);
  writers.set(root, write);
  const files = {
    'package.json': '{"type":"module"}\n',
    'packages/alpha/index.js': 'export { a } from "./src/core/a.js";\n',
    'packages/alpha/src/core/a.js': 'export const a = 1;\n',
    [ALPHA_TEST]: 'import { a } from "../index.js";\nvoid a;\n',
    'packages/beta/index.js': 'export { b } from "./src/core/b.js";\n',
    'packages/beta/src/core/b.js': 'export const b = 1;\n',
    'packages/beta/tests/b.test.js': 'import { b } from "../index.js";\nvoid b;\n',
    'apps/gamma/index.js': 'export { g } from "./src/shell/g.js";\n',
    'apps/gamma/src/shell/g.js': 'export const g = 1;\n',
    [GAMMA_TEST]: 'import { g } from "../index.js";\nvoid g;\n',
    'lib/shared.js': 'export const shared = 1;\n',
    'test/journey.test.js': 'import "../packages/alpha/index.js";\nimport "../packages/beta/index.js";\nimport { spawnSync } from "node:child_process";\nspawnSync("git");\n',
    [LINTS_TEST]: '// Reads the cells plan shards: packages/codemap/data/plan/01-alpha.json\nimport "../packages/alpha/index.js";\nimport "../packages/beta/index.js";\nimport { readFileSync } from "node:fs";\nreadFileSync("packages/codemap/data/plan/01-alpha.json");\n',
    'packages/gate/data/tests/test-cells.json': listing(sealed),
    'packages/gate/data/ceilings/cells-edges.json': edges({ 'packages/alpha/src/core/a.js': { cells: 0, deep: 0 }, 'packages/beta/src/core/b.js': { cells: 0, deep: 0 } }, { alpha: { imports: [], deepImporters: 0 }, beta: { imports: [], deepImporters: 0 } }),
    'packages/gate/data/tests/test-fixtures.json': { [ALPHA_TEST]: { tempdir: 1 }, 'packages/beta/tests/b.test.js': { tempdir: 1 } },
    'packages/codemap/data/plan/01-alpha.json': shard(1, 'alpha', 'packages/alpha', [['src/a.js', 'packages/alpha/src/core/a.js', 'seed']]),
    'packages/codemap/data/plan/02-beta.json': shard(2, 'beta', 'packages/beta', [['src/b.js', 'packages/beta/src/core/b.js', 'seed']]),
  };
  for (const [file, source] of Object.entries(files)) put(root, file, source);
  writeTestTiers(root);
  return { root, base: commit(root, {}) };
}

/** What a builder's item adds to a cell's tests, with the rows every cell item writes into the listings beside it. */
function alphaChange(root, extra = {}) {
  const newTest = 'packages/alpha/tests/a2.test.js';
  put(root, 'packages/alpha/src/core/a.js', 'export const a = 2;\n');
  put(root, newTest, 'import { a } from "../index.js";\nvoid a;\n');
  writeTestTiers(root);
  return commit(root, {
    'packages/gate/data/tests/test-cells.json': listing(['alpha', 'apps/gamma'], { findings: { [newTest]: [] } }),
    'packages/gate/data/ceilings/cells-edges.json': edges({ 'packages/alpha/src/core/a.js': { cells: 0, deep: 1 }, 'packages/beta/src/core/b.js': { cells: 0, deep: 0 } }, { alpha: { imports: [], deepImporters: 0 }, beta: { imports: [], deepImporters: 0 } }),
    'packages/codemap/data/plan/01-alpha.json': shard(1, 'alpha', 'packages/alpha', [['src/a.js', 'packages/alpha/src/core/a.js', 'seed'], ['src/a2.js', 'packages/alpha/src/core/a2.js', 'rule']]),
    ...extra,
  });
}

test('gate.confinement.change-inside-sealed-apps-name: #4633 clause 1: a change inside a sealed apps/<name> cell confines to that cell [C7]', t => {
  const { root, base } = fixture(t);
  const head = commit(root, { 'apps/gamma/src/shell/g.js': 'export const g = 2;\n' });
  const plan = selectTestTiers(root, { base, commit: head });
  assert.deepEqual(plan.units, [GAMMA_TEST], 'only the apps cell\'s own test runs');
  assert.deepEqual(plan.journeys, [], 'no root journey rides along');
  assert.deepEqual(plan.sealedCells, ['alpha', 'apps/gamma']);
});

test('gate.confinement.apps-cell-listing-does-not: #4633 clause 1: an apps cell the listing does not seal is not confined [C7]', t => {
  const { root, base } = fixture(t, ['alpha', 'gamma']);
  const head = commit(root, { 'apps/gamma/src/shell/g.js': 'export const g = 2;\n' });
  const plan = selectTestTiers(root, { base, commit: head });
  assert.ok(plan.journeys.includes('test/journey.test.js'), 'the bare name does not seal an apps cell, so the journeys stay');
});

test('gate.confinement.sealed-cell-change-only-own: #4633 clause 2: a sealed-cell change with only its own listing rows stays confined [C7]', t => {
  const { root, base } = fixture(t);
  const head = alphaChange(root);
  const plan = selectTestTiers(root, { base, commit: head });
  assert.deepEqual(plan.changed.filter(file => /^(?:bin|packages\/(?:gate|codemap))\//u.test(file)).sort(),
    ['packages/codemap/data/plan/01-alpha.json', 'packages/gate/data/ceilings/cells-edges.json', 'packages/gate/data/tests/test-cells.json', TIERS], 'every listing file rides with the change');
  assert.deepEqual(plan.units, [ALPHA_TEST, 'packages/alpha/tests/a2.test.js'], 'the cell\'s tests, new one included');
  assert.ok(!plan.journeys.includes('test/journey.test.js'), 'no unrelated root journey');
  assert.doesNotThrow(() => requireSealedSkips(root, plan), 'the plan passes the completeness guard');
});

test('gate.confinement.cell-lints-any-test-reads: #4633 clause 2: the cell lints and any test that reads a changed listing still run [C7]', t => {
  const { root, base } = fixture(t);
  const head = alphaChange(root);
  const plan = selectTestTiers(root, { base, commit: head });
  assert.deepEqual(plan.journeys, [LINTS_TEST], 'the test naming the cells plan is the only journey, so it still runs');
  const submit = submitGatePlan(root, { gate: 'true', affectedTests: 'node --test', submitInvariants: [], registryGuards: [] }, { base, commit: head });
  assert.deepEqual(submit.testTiers.journeys, [LINTS_TEST], 'submit defers the same journey to landing');
  assert.deepEqual(submit.proofFiles, [ALPHA_TEST, 'packages/alpha/tests/a2.test.js'], 'submit proves the cell\'s units; static checks stay in their own phase and are never trimmed by selection');
});

test('gate.confinement.regenerated-sections-even-rows-other: #4633 clause 2: regenerated sections, even rows of other cells, are part of the change [C7]', t => {
  const { root, base } = fixture(t);
  const head = alphaChange(root, {
    'packages/gate/data/ceilings/cells-edges.json': edges({ 'packages/alpha/src/core/a.js': { cells: 0, deep: 1 }, 'packages/beta/src/core/b.js': { cells: 1, deep: 0 } }, { alpha: { imports: [], deepImporters: 0 }, beta: { imports: [], deepImporters: 0 } }),
    'packages/gate/data/tests/test-cells.json': listing(['alpha', 'apps/gamma'], { findings: { 'packages/beta/tests/b.test.js': ['x'] }, rootTests: 1 }),
  });
  const plan = selectTestTiers(root, { base, commit: head });
  assert.ok(!plan.journeys.includes('test/journey.test.js'), 'the ceilings and the ratchet are written by a tool and checked by the static checks');
});

test('gate.confinement.policy-row-another-cell-another: #4633 clause 3: a policy row of another cell, another cell\'s shard or a plan file no cell owns breaks confinement [C7]', t => {
  const policy = fixture(t);
  const helper = alphaChange(policy.root, { 'packages/gate/data/tests/test-cells.json': listing(['alpha', 'apps/gamma'], { pureHelpers: { 'test/shared-fixture.js': 'audited' } }) });
  assert.ok(selectTestTiers(policy.root, { base: policy.base, commit: helper }).journeys.includes('test/journey.test.js'), 'a pure helper is policy outside the changed cells');
  const other = fixture(t);
  const foreign = alphaChange(other.root, { 'packages/codemap/data/plan/02-beta.json': shard(2, 'beta', 'packages/beta', []) });
  assert.ok(selectTestTiers(other.root, { base: other.base, commit: foreign }).journeys.includes('test/journey.test.js'), 'beta is not a changed cell');
  const global = fixture(t);
  const transition = alphaChange(global.root, { 'packages/codemap/data/plan/transition.json': { moves: [] } });
  assert.ok(selectTestTiers(global.root, { base: global.base, commit: transition }).journeys.includes('test/journey.test.js'), 'the transition file is global');
});

test('gate.confinement.change-touching-unsealed-cell-shared: #4633 clause 3: a change touching an unsealed cell or shared code is not confined [C7]', t => {
  const { root, base } = fixture(t);
  const open = commit(root, { 'packages/alpha/src/core/a.js': 'export const a = 2;\n', 'packages/beta/src/core/b.js': 'export const b = 2;\n' });
  assert.ok(selectTestTiers(root, { base, commit: open }).journeys.includes('test/journey.test.js'), 'beta is not sealed');
  const shared = commit(root, { 'packages/alpha/src/core/a.js': 'export const a = 3;\n', 'lib/shared.js': 'export const shared = 2;\n' });
  assert.ok(selectTestTiers(root, { base: open, commit: shared }).journeys.includes('test/journey.test.js'), 'shared code is not a cell');
});

test('gate.confinement.sealed-cell-change-plus-only: #4638 clause 1: a sealed-cell change plus only its own test-fixtures.json rows confines [C7]', t => {
  const { root, base } = fixture(t);
  const head = alphaChange(root, { 'packages/gate/data/tests/test-fixtures.json': { [ALPHA_TEST]: { tempdir: 2 }, 'packages/alpha/tests/a2.test.js': { tempdir: 1 }, 'packages/beta/tests/b.test.js': { tempdir: 1 } } });
  const plan = selectTestTiers(root, { base, commit: head });
  assert.ok(plan.changed.includes('packages/gate/data/tests/test-fixtures.json'), 'the registry rides with the change');
  assert.ok(!plan.journeys.includes('test/journey.test.js'), 'rows for the cell\'s own tests keep the change confined');
});

test('gate.confinement.test-fixtures-json-row-unchanged: #4638 clause 2: a test-fixtures.json row for an unchanged cell breaks confinement [C7]', t => {
  const { root, base } = fixture(t);
  const head = alphaChange(root, { 'packages/gate/data/tests/test-fixtures.json': { [ALPHA_TEST]: { tempdir: 1 }, 'packages/beta/tests/b.test.js': { tempdir: 2 } } });
  const plan = selectTestTiers(root, { base, commit: head });
  assert.ok(plan.journeys.includes('test/journey.test.js'), 'beta is not a changed cell');
});

test('gate.confinement.unit-narrowed-sealed-cell-passes: #5671 clause 1: a unit narrowed to a sealed cell passes the guard [C7]', t => {
  const { root, base } = fixture(t);
  const moved = 'apps/gamma/tests/moved.test.js';
  const head = commit(root, { [moved]: 'import { g } from "../index.js";\nvoid g;\n', 'apps/gamma/src/shell/g.js': 'export const g = 2;\n' });
  const plan = selectTestTiers(root, { base, commit: head });
  assert.deepEqual(plan.units, [GAMMA_TEST, moved], 'selection narrows to the sealed cell\'s own tests');
  assert.doesNotThrow(() => requireSealedSkips(root, plan), 'the narrowing to the sealed cell is accepted');
});

test('gate.confinement.unsealed-package-still-has-select: #5671 clause 1: an unsealed package still has to select its unit tests [C7]', t => {
  const { root, base } = fixture(t, ['alpha']);
  const head = commit(root, { 'packages/beta/src/core/b.js': 'export const b = 2;\n' });
  const plan = selectTestTiers(root, { base, commit: head });
  assert.throws(() => requireSealedSkips(root, { ...plan, units: [] }), /TEST_SELECTION_INCOMPLETE|neither selected nor skipped/u);
});
