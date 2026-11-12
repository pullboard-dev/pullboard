/** @pullboard-test-loads packages/gate/src/io/test/tier/selection.js */
/** The tooling tier is computed from the import graph and runs only when a former bin file or a checked rule changes [C7,#4015]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectTestTiers } from '../../../../index.js';
import { writeTestTiers } from '../../../../index.js';
import { toolingTests } from '../../../../src/io/test/tier/selection.js';
import { fixture as repository } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';

const SIZE_TEST = 'packages/gate/tests/io/size.test.js';
const OTHER_TEST = 'packages/gate/tests/io/other.test.js';
const MIXED_TEST = 'packages/gate/tests/io/mixed.test.js';
const WEB_TEST = 'packages/web/tests/page.test.js';

/**
 * A repository after the layout freeze: the path map sends bin/checks/size.js and its rule to packages/gate, one test
 * reaches only that script, one reaches an ordinary gate module, one reaches both, and a web cell stands apart.
 */
function frozen(t) {
  const { root, put } = repository(t);
  put('packages/codemap/data/plan/path-map/freeze.json', JSON.stringify({ 'bin/checks/size.js': 'packages/gate/src/io/size.js', 'bin/checks/size.json': 'packages/gate/data/ceilings/size.json' }));
  put('packages/gate/data/ceilings/size.json', '{"cap":1500}\n');
  put('packages/gate/src/io/size.js', 'export const size = 1;\n');
  put('packages/gate/src/io/other.js', 'export const other = 1;\n');
  put(SIZE_TEST, "import { size } from '../../src/io/size.js';\nvoid size;\n");
  put(OTHER_TEST, "import { other } from '../../src/io/other.js';\nvoid other;\n");
  put(MIXED_TEST, "import { size } from '../../src/io/size.js';\nimport { other } from '../../src/io/other.js';\nvoid [size, other];\n");
  put('packages/web/src/page.js', 'export const page = 1;\n');
  put(WEB_TEST, "import { page } from '../src/page.js';\nvoid page;\n");
  writeTestTiers(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'freeze');
  return { root, put, base: git(root, 'rev-parse', 'HEAD').trim() };
}

/** Commit one change on top of the frozen repository and select its tiers. */
function change(box, files) {
  for (const [file, source] of Object.entries(files)) box.put(file, source);
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'change');
  const commit = git(box.root, 'rev-parse', 'HEAD').trim();
  return selectTestTiers(box.root, { base: box.base, commit });
}

test('clause 2: the tooling tier is the tests whose only production inputs are the former checks scripts, derived from the import graph [C7,#4015]', t => {
  const box = frozen(t);
  assert.deepEqual(toolingTests(box.root, box.base), [SIZE_TEST], 'the mixed test also reaches another module, so it is no tooling test');
  // A new test that imports only the script joins the tier with no list edited anywhere.
  box.put('packages/gate/tests/io/size-again.test.js', "import { size } from '../../src/io/size.js';\nvoid size;\n");
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'add');
  assert.deepEqual(toolingTests(box.root, 'HEAD'), ['packages/gate/tests/io/size-again.test.js', SIZE_TEST]);
});

test('clause 1: a cell-only change skips the tooling tier while the cell\'s other tests run [C7,#4015]', t => {
  const box = frozen(t);
  const plan = change(box, { 'packages/gate/src/io/other.js': 'export const other = 2;\n' });
  assert.ok(plan.units.includes(OTHER_TEST) && plan.units.includes(MIXED_TEST), `the changed module's tests run: ${plan.units}`);
  assert.ok(!plan.units.includes(SIZE_TEST), 'the tooling test reaches nothing that changed');
  const web = change(frozen(t), { 'packages/web/src/page.js': 'export const page = 2;\n' });
  assert.deepEqual(web.units, [WEB_TEST]);
});

test('clause 1: a change to a file formerly under bin selects the tooling tier [C7,#4015]', t => {
  const plan = change(frozen(t), { 'packages/gate/src/io/size.js': 'export const size = 2;\n' });
  assert.ok(plan.units.includes(SIZE_TEST), `the checks script's test runs: ${plan.units}`);
});

test('clause 2: a change to a checked rule still selects its tooling tests, even from another cell [C7,#4015]', t => {
  const box = frozen(t);
  // The rule sits in the data folder, which no test imports; only the path map ties it to the checks.
  const plan = change(box, { 'packages/gate/data/ceilings/size.json': '{"cap":1400}\n' });
  assert.ok(plan.units.includes(SIZE_TEST), `the rule's tooling test runs: ${plan.units}`);
});
