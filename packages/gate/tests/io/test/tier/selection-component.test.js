/** @pullboard-test-input source-cell gate landing */
/** With gate.componentTier a submit reruns a T2 test only when a front door it reaches changes [C7,#9788]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectTestTiers } from '../../../../index.js';
import { writeTestTiers } from '../../../../index.js';
import { fixture as repository } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';

const DOORS_TEST = 'test/doors.test.js';
const sources = {
  'packages/math/index.js': 'export { add } from "./src/add.js";\n',
  'packages/math/src/add.js': 'export const add = (a, b) => a + b;\n',
  'packages/text/index.js': 'export const title = "text";\n',
  'test/doors.test.js': 'import "../packages/text/index.js";\nimport "../packages/math/index.js";\n',
};

/** A committed base holding the sources, and a change on top of it selected with the given option. */
function select(t, files, option, tree = sources) {
  const { root, put } = repository(t);
  put('package.json', '{"type":"module"}\n');
  for (const [file, source] of Object.entries(tree)) put(file, source);
  git(root, 'add', '-A');
  writeTestTiers(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  for (const [file, source] of Object.entries(files)) put(file, source);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
  return selectTestTiers(root, { base, commit: git(root, 'rev-parse', 'HEAD').trim(), ...option });
}

test('gate.io-test-tier-selection-component.a-change-to-a-front-door: clause 1: a change to a front door selects the T2 test that reaches it [C7,#9788]', t => {
  const plan = select(t, { 'packages/math/index.js': 'export { add } from "./src/add.js";\nexport const two = 2;\n' }, { componentTier: true });
  assert.ok(plan.units.includes(DOORS_TEST), `the T2 test runs: ${plan.units}`);
});

test('gate.io-test-tier-selection-component.a-change-to-an-internal-file: clause 2: a change to an internal file of that cell does not select the T2 test [C7,#9788]', t => {
  const plan = select(t, { 'packages/math/src/add.js': 'export const add = (a, b) => b + a;\n' }, { componentTier: true });
  assert.ok(!plan.units.includes(DOORS_TEST), `the T2 test stays out: ${plan.units}`);
  assert.ok(!plan.journeys.includes(DOORS_TEST), 'and it is no journey');
});

test('gate.io-test-tier-selection-component.a-tiers-file-with-no-t2: clause 3: a tiers file with no T2 row selects what it does today [C7,#9788]', t => {
  const { [DOORS_TEST]: _, ...rest } = sources;
  const tree = { ...rest, 'test/deep.test.js': 'import "../packages/text/index.js";\nimport "../packages/math/src/add.js";\n' };
  const change = { 'packages/math/src/add.js': 'export const add = (a, b) => b + a;\n' };
  const off = select(t, change, {}, tree);
  const on = select(t, change, { componentTier: true }, tree);
  assert.deepEqual({ ...on, commit: null, base: null }, { ...off, commit: null, base: null });
});
