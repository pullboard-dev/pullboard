/** A shared helper starts child test runs without the runner context and fails on zero tests; new direct spawns are refused [V4]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import {
  join,
  resolve,
} from 'node:path';
import {
  after,
  test,
} from 'node:test';
import {
  GRANDFATHERED_DIRECT_SPAWNERS,
  refusedDirectSpawners,
  runChildTests,
  spawnsTestsDirectly,
} from '../../fixtures/child-tests.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const dirs = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

/** Write one file in a fresh private directory and return the directory and the file's path. */
function privateFile(name, body) {
  const files = privateFixtureFiles('pullboard-child-test-');
  dirs.push(files.root);
  files.write(name, body);
  return { dir: files.root, file: join(files.root, name) };
}

test('gate.io-run-child-test-context.the-helper-runs-a-one-test: clause 1: the helper runs a one-test child and sees one pass, even under an inherited test context [V4]', () => {
  const { dir, file } = privateFile('child.test.js', "import { test } from 'node:test';\ntest('one', () => {});\n");
  const result = runChildTests([file], { cwd: dir, env: { ...process.env, NODE_TEST_CONTEXT: 'child-v8' } });
  assert.deepEqual([result.status, result.tests, result.pass, result.fail], [0, 1, 1, 0]);
});

test('gate.io-run-child-test-context.a-child-that-reports-zero-tests: clause 1: a child that reports zero tests fails instead of passing on nothing [V4]', () => {
  const { dir, file } = privateFile('child.test.js', '// no tests here\n');
  assert.throws(() => runChildTests([file], { cwd: dir }), /zero tests/u);
});

/** How many files the grandfather list held when the lint arrived; it may only go down. */
const GRANDFATHER_CEILING = 23;

/** A source file that spawns node --test itself, assembled so this file does not match its own lint. */
const directSpawnSource = `spawnSync(process.execPath, ['${['--', 'test'].join('')}', file], { cwd });\n`;

test('gate.io-run-child-test-context.a-new-direct-child-node-test: clause 2: a new direct child node --test spawn outside the helper is refused unless grandfathered [V4]', () => {
  assert.equal(spawnsTestsDirectly(directSpawnSource), true);
  assert.equal(spawnsTestsDirectly('runChildTests([file], { cwd });'), false);
  const { dir } = privateFile('apps/demo/journeys/new-spawner.test.js', directSpawnSource);
  assert.deepEqual(refusedDirectSpawners(dir, []), ['apps/demo/journeys/new-spawner.test.js']);
  assert.deepEqual(refusedDirectSpawners(dir, ['apps/demo/journeys/new-spawner.test.js']), []);
});

test('gate.io-run-child-test-context.the-repository-adds-no-direct-spawner: clause 2: the repository adds no direct spawner, and adding a file to the grandfather list is refused [V4]', () => {
  const root = resolve(import.meta.dirname, '../../../../..');
  assert.deepEqual(refusedDirectSpawners(root), [], 'spawn child test runs through runChildTests in packages/gate/tests/fixtures/child-tests.js, not directly');
  assert.ok(GRANDFATHERED_DIRECT_SPAWNERS.length <= GRANDFATHER_CEILING, 'the grandfather list may only shrink: adding a file to it is refused');
  assert.equal(new Set(GRANDFATHERED_DIRECT_SPAWNERS).size, GRANDFATHERED_DIRECT_SPAWNERS.length, 'the grandfather list names each file once');
});
