/** Per-file static results kept by blob equal a full run's rows, and a rule or tooling change drops them [C7,#5564]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { testWaitReport } from '../../../../packages/gate/src/io/test/waits.js';
import { blobOid } from '../../../../packages/gate/src/io/static/cache.js';
import { fileCache } from '../../../../packages/gate/src/io/static/cache.js';
import { cellRows } from '../../../../packages/gate/src/io/static/cache.js';
import { cellScopedKey } from '../../../../packages/gate/src/io/static/cache.js';
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

/** Three cells in memory: `b` imports `a`, `c` imports nothing; any file holding BAD is a finding. */
function cellSources(overrides = {}) {
  const files = {
    'packages/a/index.js': 'export const a = 1;\n',
    'packages/b/index.js': "import { a } from '../a/index.js';\nexport const b = a;\n",
    'packages/c/index.js': 'export const c = 3;\n',
    ...overrides,
  };
  return Object.entries(files).map(([file, source]) => ({ file, source }));
}

/** A compute that records which files it was handed, and finds BAD in them. */
function badRows(seen) {
  return reach => { seen.push(reach.map(row => row.file)); return reach.filter(row => row.source.includes('BAD')).map(row => ({ file: row.file, line: 1, text: 'bad' })); };
}

test('clause 1: cell-partitioned rows equal a full run, and a change reruns only the cells that read it [C7,#5564]', () => {
  const edgeCache = fileCache({ name: 'cell-edges', version: 1, tooling: 't', home: null });
  const cache = fileCache({ name: 'rows', version: 1, tooling: 't', home: null });
  const seen = [];
  const full = sources => sources.filter(row => row.source.includes('BAD')).map(row => ({ file: row.file, line: 1, text: 'bad' }));
  const first = cellSources({ 'packages/a/index.js': 'export const a = BAD;\n' });
  assert.deepEqual(cellRows({ sources: first, edgeCache, cache, compute: badRows(seen) }), full(first));
  assert.equal(cache.misses, 3, 'a cold cache computes every cell');
  seen.length = 0;
  assert.deepEqual(cellRows({ sources: first, edgeCache, cache, compute: badRows(seen) }), full(first));
  assert.equal(seen.length, 0, 'an unchanged tree computes nothing');
  const changed = cellSources({ 'packages/a/index.js': 'export const a = BAD;\n', 'packages/c/index.js': 'export const c = BAD;\n' });
  assert.deepEqual(cellRows({ sources: changed, edgeCache, cache, compute: badRows(seen) }), full(changed));
  assert.deepEqual(seen.flat(), ['packages/c/index.js'], 'only cell c, which imports nothing, was handed to the check');
  seen.length = 0;
  const imported = cellSources({ 'packages/a/index.js': 'export const a = 2;\n', 'packages/c/index.js': 'export const c = BAD;\n' });
  assert.deepEqual(cellRows({ sources: imported, edgeCache, cache, compute: badRows(seen) }), full(imported));
  assert.ok(seen.flat().includes('packages/b/index.js'), 'cell b imports the changed cell a, so it is rerun with it');
  assert.ok(!seen.flat().includes('packages/c/index.js'), 'cell c reads neither, so it is not rerun');
});

test('clause 1: a scoped key moves only with the cells it reads and the cells they import [C7,#5564]', () => {
  const edgeCache = fileCache({ name: 'cell-edges', version: 1, tooling: 't', home: null });
  const keyOf = (sources, cells) => cellScopedKey(sources, cells, { edgeCache, paths: false });
  const base = cellSources();
  const touchedC = cellSources({ 'packages/c/index.js': 'export const c = 4;\n' });
  const touchedA = cellSources({ 'packages/a/index.js': 'export const a = 5;\n' });
  assert.equal(keyOf(base, ['b']), keyOf(touchedC, ['b']));
  assert.notEqual(keyOf(base, ['b']), keyOf(touchedA, ['b']));
  assert.notEqual(keyOf(base, ['c']), keyOf(touchedC, ['c']));
});
