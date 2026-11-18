/** A scoped static run reads only the changed files; whole-tree classes no longer scan the rest of the tree [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { STATIC_TREE_CHECKS } from '../../../src/io/static/registry.js';
import { privateFixtureFiles } from '../../fixtures/child.js';

const CLASSES = ['test-waits', 'cli-launches', 'test-fixtures', 'import-style'];
const WAIT = "import { test } from 'node:test';\ntest('x', async () => { await new Promise(done => setTimeout(done, 500)); });\n";
const CLEAN = "import { test } from 'node:test';\ntest('x', () => {});\n";

/** A fixture tree with `count` clean test files and the ceilings the classes read. */
function tree(count) {
  const files = privateFixtureFiles('pb-scoped-');
  files.write('packages/gate/data/baselines/test-waits-baseline.json', '{}\n');
  files.write('packages/gate/data/baselines/cli-launches.json', '{}\n');
  files.write('packages/gate/data/tests/test-fixtures.json', '{}\n');
  for (let at = 0; at < count; at++) files.write(`packages/gate/tests/clean${at}.test.js`, CLEAN);
  files.write('packages/gate/tests/changed.test.js', WAIT);
  return files;
}

/** Run the classes scoped to `changed`, with a cache that records each file a class judged. */
function run(root, changed) {
  const read = new Set(), rows = [];
  const context = { changed, cache: () => ({ get: (file, blob, compute) => { read.add(file); return compute(); }, save() {} }) };
  for (const name of CLASSES) rows.push(...STATIC_TREE_CHECKS.find(check => check.name === name).run(root, [], context));
  return { read, rows };
}

test('gate.io-static-scoped-reads.with-one-changed-file-in-scope: clause 1: with one changed file in scope the check classes read only that file, not the rest of the tree [C7]', t => {
  const files = tree(25);
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const whole = run(files.root, null);
  assert.ok(whole.read.size > 25, `a whole-tree run reads every test file, got ${whole.read.size}`);
  const scoped = run(files.root, ['packages/gate/tests/changed.test.js']);
  assert.deepEqual([...scoped.read], ['packages/gate/tests/changed.test.js']);
});

test('gate.io-static-scoped-reads.a-red-finding-in-the-changed: clause 2: a red finding in the changed file is still reported with its file and line [C7]', t => {
  const files = tree(3);
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const { rows } = run(files.root, ['packages/gate/tests/changed.test.js']);
  assert.ok(rows.some(row => /^packages\/gate\/tests\/changed\.test\.js:\d+: /u.test(row)), rows.join('\n') || 'no rows');
});
