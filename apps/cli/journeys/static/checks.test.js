/** Per-file static results kept by blob equal a full run's rows, and a rule or tooling change drops them [C7,#5564]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { testWaitReport } from '../../../../packages/gate/src/io/test/waits.js';
import { blobOid } from '../../../../packages/gate/src/io/static/cache.js';
import { fileCache } from '../../../../packages/gate/src/io/static/cache.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';

/** A tree with two test files: one sleeps between probes, one is clean. */
function writeTree(tree) {
  tree.write('packages/demo/tests/a.test.js', "import { setTimeout as sleep } from 'node:timers/promises';\nawait sleep(500);\n");
  tree.write('packages/demo/tests/b.test.js', 'export const b = 1;\n');
}

/** Run the test-waits scan with a cache kept in `home`, as the registry runs it. */
function cachedRows(root, home, version = 1, tooling = 't') {
  const cache = fileCache({ name: 'test-waits', version, tooling, home });
  const rows = testWaitReport(root, { cache });
  cache.save();
  return { rows, hits: cache.hits, misses: cache.misses };
}

test('clause 1: cached rows equal a full run on a fixture tree, and an unchanged file is reused [C7,#5564]', t => {
  const tree = privateFixtureFiles('pb-static-cache-');
  const home = privateFixtureFiles('pb-static-home-').root;
  t.after(() => { rmSync(tree.root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });
  writeTree(tree);
  const full = testWaitReport(tree.root);
  const cold = cachedRows(tree.root, home);
  assert.deepEqual(cold.rows, full);
  assert.equal(cold.hits, 0);
  assert.ok(full.length > 0, 'the fixture holds a wait, so equality is not vacuous');
  const warm = cachedRows(tree.root, home);
  assert.deepEqual(warm.rows, full);
  assert.equal(warm.misses, 0, 'a second run reads every file from the cache');
  tree.write('packages/demo/tests/b.test.js', "import { setTimeout as sleep } from 'node:timers/promises';\nawait sleep(900);\n");
  const changed = cachedRows(tree.root, home);
  assert.deepEqual(changed.rows, testWaitReport(tree.root));
  assert.equal(changed.misses, 1, 'only the changed file is rescanned');
  assert.equal(changed.hits, 1);
  assert.ok(changed.rows.length > full.length, 'the changed file now adds a row');
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
