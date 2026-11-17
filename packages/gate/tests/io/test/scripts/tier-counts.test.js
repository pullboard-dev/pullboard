/** @pullboard-test-input source-cell gate landing */
/** The tier-counts script reports T1, T2 and T3 counts and what one front door change selects [C7,#9789]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { writeTestTiers } from '../../../../index.js';
import { fixture as repository } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';

const SCRIPT = new URL('../../../../src/io/test/scripts/tier-counts.js', import.meta.url).pathname;
const sources = {
  'packages/math/index.js': 'export { add } from "./src/add.js";\n',
  'packages/math/src/add.js': 'export const add = (a, b) => a + b;\n',
  'packages/text/index.js': 'export const title = "text";\n',
  'test/doors.test.js': 'import "../packages/text/index.js";\nimport "../packages/math/index.js";\n',
  'test/single.test.js': 'import "../packages/math/index.js";\n',
};

/** A committed fixture tree holding the sources and their generated tier manifest. */
function committed(t) {
  const { root, put } = repository(t);
  put('package.json', '{"type":"module"}\n');
  for (const [file, source] of Object.entries(sources)) put(file, source);
  git(root, 'add', '-A');
  writeTestTiers(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  return root;
}

/** Run the script against a root with extra arguments. */
function run(root, ...args) { return spawnSync(process.execPath, [SCRIPT, ...args, root], { encoding: 'utf8' }); }

test('clause 1: the script prints the T1, T2 and T3 counts of a fixture tree, componentTier off and on [C7,#9789]', t => {
  const result = run(committed(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /componentTier off: T1 \d+, T2 0, T3 \d+/u);
  const on = /componentTier on: T1 (\d+), T2 (\d+), T3 (\d+)/u.exec(result.stdout);
  assert.ok(on, result.stdout);
  assert.equal(on[2], '1', 'only the two-door test is T2');
});

test('clause 2: the script prints the files a one-line change to one named front door selects [C7,#9789]', t => {
  const result = run(committed(t), '--door', 'packages/math/index.js');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /componentTier off: packages\/math\/index\.js change selects \d+ files/u);
  assert.match(result.stdout, /componentTier on: packages\/math\/index\.js change selects \d+ files\n(?:.*\n)*? {2}test\/doors\.test\.js/u);
});
