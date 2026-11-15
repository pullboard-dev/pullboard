/** @pullboard-test-loads packages/gate/src/io/test/tier/selection.js */
/** Tier selection keeps every test for a global change, runs a new tooling test at submit, and ignores a project without a path map [C7,#4015]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeTestTiers } from '../../../../index.js';
import { toolingTests } from '../../../../src/io/test/tier/selection.js';
import { fixture as repository } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';
import { frozen } from './frozen.js';
import { change } from './frozen.js';
import { OTHER_TEST } from './frozen.js';
import { SIZE_TEST } from './frozen.js';
import { WEB_TEST } from './frozen.js';

test('a global change keeps the tooling tier with every other test [C7,#4015]', t => {
  const plan = change(frozen(t), { 'package.json': '{"type":"module","private":true}\n' });
  for (const file of [SIZE_TEST, OTHER_TEST, WEB_TEST]) assert.ok(plan.units.includes(file), `${file} runs: ${plan.units}`);
});

test('a tooling test the change itself adds runs at submit though no former bin file changed [C7,#4015]', t => {
  const added = 'packages/gate/tests/io/size-new.test.js';
  const plan = change(frozen(t), { [added]: "import { size } from '../../src/io/size.js';\nvoid size;\n" });
  assert.ok(plan.units.includes(added), `the builder's own new test runs: ${plan.units}`);
  assert.ok(!plan.units.includes(SIZE_TEST), 'the unchanged tooling test stays out');
});

test('a project without a layout path map has no tooling tier and selects as before [C7,#4015]', t => {
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
