/** @pullboard-test-loads packages/gate/src/io/test/tier/selection.js */
/** The tooling tier is computed from the import graph and runs only when a former bin file or a checked rule changes [C7,#4015]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toolingTests } from '../../../../src/io/test/tier/selection.js';
import { writeTestTiers } from '../../../../heavy.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';
import { frozen } from './frozen.js';
import { change } from './frozen.js';
import { OTHER_TEST } from './frozen.js';
import { MIXED_TEST } from './frozen.js';
import { SIZE_TEST } from './frozen.js';
import { WEB_TEST } from './frozen.js';

test('gate.io-test-tier-tooling.the-tooling-tier-is-the-tests: clause 2: the tooling tier is the tests whose only production inputs are the former checks scripts, derived from the import graph [C7,#4015]', t => {
  const box = frozen(t);
  assert.deepEqual(toolingTests(box.root, box.base), [SIZE_TEST], 'the mixed test also reaches another module, so it is no tooling test');
  // A new test that imports only the script joins the tier with no list edited anywhere.
  box.put('packages/gate/tests/io/size-again.test.js', "import { size } from '../../src/io/size.js';\nvoid size;\n");
  git(box.root, 'add', '-A');
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'add');
  assert.deepEqual(toolingTests(box.root, 'HEAD'), ['packages/gate/tests/io/size-again.test.js', SIZE_TEST]);
});

test('gate.io-test-tier-tooling.a-cell-only-change-skips-the: clause 1: a cell-only change skips the tooling tier while the cell\'s other tests run [C7,#4015]', t => {
  const box = frozen(t);
  const plan = change(box, { 'packages/gate/src/io/other.js': 'export const other = 2;\n' });
  assert.ok(plan.units.includes(OTHER_TEST) && plan.units.includes(MIXED_TEST), `the changed module's tests run: ${plan.units}`);
  assert.ok(!plan.units.includes(SIZE_TEST), 'the tooling test reaches nothing that changed');
  const web = change(frozen(t), { 'packages/web/src/page.js': 'export const page = 2;\n' });
  assert.deepEqual(web.units, [WEB_TEST]);
});

test('gate.io-test-tier-tooling.a-change-to-a-file-formerly: clause 1: a change to a file formerly under bin selects the tooling tier [C7,#4015]', t => {
  const plan = change(frozen(t), { 'packages/gate/src/io/size.js': 'export const size = 2;\n' });
  assert.ok(plan.units.includes(SIZE_TEST), `the checks script's test runs: ${plan.units}`);
});

test('gate.io-test-tier-tooling.a-change-to-a-checked-rule: clause 2: a change to a checked rule still selects its tooling tests, even from another cell [C7,#4015]', t => {
  const box = frozen(t);
  // The rule sits in the data folder, which no test imports; only the path map ties it to the checks.
  const plan = change(box, { 'packages/gate/data/ceilings/size.json': '{"cap":1400}\n' });
  assert.ok(plan.units.includes(SIZE_TEST), `the rule's tooling test runs: ${plan.units}`);
});
