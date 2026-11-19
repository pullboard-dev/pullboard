/** The test action cache reads the post-move tree: source-tree declarations find inputs, and every analyzer file exists [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  ANALYZER_FILES,
  TREE_DECLARATIONS,
  declaredReads,
  settleTestActions,
  treeIndex,
} from '../../../../src/io/test/action/cache.js';
import { storeName } from '../../../../src/io/store-names.js';
import {
  importTestResults,
  packTestResults,
  selectedTestResults,
  testResultDigest,
} from '../../../../src/io/test/store.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';
import { policyRepository } from '../../../../../store/tests/fixtures/submit.js';

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

/** One finished run folder: a clean repository at one commit, a plan keyed for one test file, and that file's staged green with its TAP. */
function stagedRun(testCase) {
  const directory = privateFixtureFiles('pullboard-settle-exit-').root;
  testCase.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo'), runDir = join(directory, 'run'), store = join(directory, 'store');
  for (const path of [root, join(runDir, 'green')]) mkdirSync(path, { recursive: true });
  policyRepository(root);
  const commit = runFixtureGit(['rev-parse', 'HEAD'], { cwd: root }).trim();
  const file = 'packages/gate/tests/io/test/example.test.js';
  const inputKey = 'b'.repeat(64);
  const context = { node: process.version, platform: process.platform, arch: process.arch, environment: [] };
  const key = testResultDigest({ inputKey, context });
  writeFileSync(join(runDir, 'keys.json'), JSON.stringify({ root, machine: 'fixture-machine', inputs: { [file]: { inputKey, context } } }));
  writeFileSync(join(runDir, 'green', storeName(testResultDigest(file))), JSON.stringify({ key, file }));
  writeFileSync(join(runDir, `${testResultDigest(file)}.tap.json`), JSON.stringify({ lines: ['ok 1 - a case'], counts: { passed: 1, failed: 0, skipped: 0, tests: 1 }, observedTests: 1 }));
  return { runDir, store, commit, key, inputKey };
}

test('gate.io-test-action-cache.settle-marks-file-exit: clause 1: a stored green carries the file exit 0 mark, survives the result packet, and a landing run that exited 1 stores nothing [C7,#11102]', t => {
  const run = stagedRun(t);
  settleTestActions(run.runDir, { store: run.store, stage: 'test', commit: run.commit, landing: false, code: 1 });
  const [stored] = selectedTestResults(run.store, [run.inputKey]);
  assert.equal(stored?.status, 'pass', 'a non-landing run promotes the staged green even when the whole job exited 1');
  assert.equal(stored.origin.fileExit, 0, 'the row says the file process exited 0');
  const packet = packTestResults(selectedTestResults(run.store, [run.inputKey]));
  assert.ok(packet, 'the row packs');
  const other = privateFixtureFiles('pullboard-settle-import-').root;
  t.after(() => rmSync(other, { recursive: true, force: true }));
  assert.equal(importTestResults(other, packet, [run.inputKey]), 1, 'the row unpacks into another store');
  assert.equal(selectedTestResults(other, [run.inputKey])[0].origin.fileExit, 0, 'the mark survives pack and import');
  const landing = stagedRun(t);
  settleTestActions(landing.runDir, { store: landing.store, stage: 'test', commit: landing.commit, landing: true, code: 1 });
  assert.equal(existsSync(join(landing.store, 'green', storeName(landing.key))), false, 'a landing run that exited 1 stores no green');
});
