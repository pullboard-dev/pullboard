/** Per-file static results kept by blob equal a full run's rows, and a rule or tooling change drops them [C7,#5564]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { styleSources } from '../../../../packages/codemap/index.js';
import { STATIC_TREE_CHECKS } from '../../../../packages/gate/src/io/static/registry.js';
import { blobOid } from '../../../../packages/gate/src/io/static/cache.js';
import { fileCache } from '../../../../packages/gate/src/io/static/cache.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

const importStyle = STATIC_TREE_CHECKS.find(check => check.name === 'import-style');

/** A tree with one clean source and one that binds two names on a line. */
function writeTree(tree, extra = '') {
  tree.write('packages/demo/index.js', `import { a } from './a.js';\nexport { a };\n${extra}`);
  tree.write('packages/demo/a.js', "import { x, y } from './b.js';\nexport const a = x + y;\n");
  tree.write('packages/demo/b.js', 'export const x = 1;\nexport const y = 2;\n');
}

/** Run import-style with a cache kept in `home`, as the registry runs it. */
function cachedRows(root, home, version = 1, tooling = 't') {
  const made = [];
  const context = { cache: (name, v) => { const cache = fileCache({ name, version: version ?? v, tooling, home }); made.push(cache); return cache; } };
  const rows = importStyle.run(root, styleSources(root), context);
  for (const cache of made) cache.save();
  return { rows, hits: made.reduce((sum, cache) => sum + cache.hits, 0), misses: made.reduce((sum, cache) => sum + cache.misses, 0) };
}

test('clause 1: cached rows equal a full run on a fixture tree, and an unchanged file is reused [C7,#5564]', t => {
  const tree = privateFixtureFiles('pb-static-cache-');
  const home = privateFixtureFiles('pb-static-home-').root;
  t.after(() => { rmSync(tree.root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  writeTree(tree);
  const full = importStyle.run(tree.root, styleSources(tree.root));
  const cold = cachedRows(tree.root, home);
  assert.deepEqual(cold.rows, full);
  assert.equal(cold.hits, 0);
  assert.ok(full.length > 0, 'the fixture holds a violation, so equality is not vacuous');
  const warm = cachedRows(tree.root, home);
  assert.deepEqual(warm.rows, full);
  assert.equal(warm.misses, 0, 'a second run reads every file from the cache');
  tree.write('packages/demo/b.js', 'export const x = 1;\nexport const y = 3;\nimport { p, q } from "./a.js";\n');
  const changed = cachedRows(tree.root, home);
  assert.deepEqual(changed.rows, importStyle.run(tree.root, styleSources(tree.root)));
  assert.equal(changed.misses, 1, 'only the changed file is rescanned');
  assert.ok(changed.hits >= 2);
});

test('clause 1: a rule version or tooling change invalidates the cached rows [C7,#5564]', t => {
  const tree = privateFixtureFiles('pb-static-version-');
  const home = privateFixtureFiles('pb-static-home-').root;
  t.after(() => { rmSync(tree.root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  writeTree(tree);
  cachedRows(tree.root, home, 1, 't1');
  assert.equal(cachedRows(tree.root, home, 1, 't1').misses, 0);
  assert.ok(cachedRows(tree.root, home, 2, 't1').misses > 0, 'a new rule version rescans every file');
  assert.ok(cachedRows(tree.root, home, 2, 't2').misses > 0, 'a new tooling tree rescans every file');
});

test('clause 1: a blob oid is git\'s own object id [C7,#5564]', () => {
  assert.equal(blobOid('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
});
