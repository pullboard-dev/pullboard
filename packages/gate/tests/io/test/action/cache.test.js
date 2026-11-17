/** The test action cache reads the post-move tree: source-tree declarations find inputs, and every analyzer file exists [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import {
  ANALYZER_FILES,
  TREE_DECLARATIONS,
  declaredReads,
  treeIndex,
} from '../../../../src/io/test/action/cache.js';

const TRACKED = [
  'apps/cli/src/io/item.js',
  'apps/cli/pullboard.js',
  'apps/cli/journeys/show/main.test.js',
  'apps/cli/tests/fixtures/child.js',
  'packages/gate/index.js',
  'packages/gate/light.js',
  'apps/cli/src/io/run/tests.js',
  'packages/gate/tests/io/test/example.test.js',
  'packages/view/browser.js',
  'docs/guide.md',
  'src/stale.js',
  'bin/stale.js',
  'test/stale.test.js',
];
const TEST_FILE = 'packages/gate/tests/io/test/example.test.js';

/** The inputs a test with the given tree declaration gets from the tracked tree above. */
function inputsOf(name) {
  const modules = new Map([[TEST_FILE, `/** @pullboard-test-input ${name} */\nexport {};\n`]]);
  const index = treeIndex(new Map(TRACKED.map(path => [path, path])));
  return declaredReads(TEST_FILE, [TEST_FILE], modules, index).inputs;
}

test('gate.io-test-action-cache.a-source-tree-test-gets-the: clause 1: a source-tree test gets the post-move source folders and cell doors, never tests or the old roots [C7]', () => {
  const inputs = inputsOf('source-tree');
  assert.ok(inputs.length > 0, 'a source-tree declaration is never an empty input set');
  for (const path of ['apps/cli/src/io/item.js', 'apps/cli/pullboard.js', 'packages/gate/index.js', 'packages/gate/light.js', 'apps/cli/src/io/run/tests.js', 'packages/view/browser.js']) {
    assert.ok(inputs.includes(path), `${path} is a source input`);
  }
  for (const path of ['apps/cli/journeys/show/main.test.js', 'apps/cli/tests/fixtures/child.js', TEST_FILE, 'docs/guide.md', 'src/stale.js', 'bin/stale.js']) {
    assert.ok(!inputs.includes(path), `${path} is not a source input`);
  }
});

test('gate.io-test-action-cache.a-test-tree-test-gets-every: clause 1: a test-tree test gets every cell test and journey, and a docs-tree test gets docs [C7]', () => {
  const tests = inputsOf('test-tree');
  assert.deepEqual(tests, ['apps/cli/journeys/show/main.test.js', 'apps/cli/tests/fixtures/child.js', TEST_FILE]);
  assert.deepEqual(inputsOf('docs-tree'), ['docs/guide.md']);
  assert.deepEqual(TREE_DECLARATIONS.map(([name]) => name), ['test-tree', 'source-tree', 'docs-tree']);
});

test('gate.io-test-action-cache.every-analyzer-file-the-cache-hashes: clause 2: every analyzer file the cache hashes exists [C7]', () => {
  assert.ok(ANALYZER_FILES.length > 0);
  for (const file of ANALYZER_FILES) {
    const url = new URL(file, new URL('../../../../src/io/test/action/cache.js', import.meta.url));
    assert.ok(existsSync(url), `${file} exists`);
  }
});
