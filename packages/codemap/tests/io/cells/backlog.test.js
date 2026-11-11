/** @pullboard-test-input source-tree packages/codemap/src/io/cell/lint/shards.js packages/codemap/src/io/cell/lint/store.js packages/codemap/data/plan/path-map/** */
/** Distinct cell moves change disjoint baseline and path-map shards in either order [C7,CD64]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../../apps/cli/tests/fixtures/child.js';
import { cellLintFiles } from '../../../index.js';
import { initializeCellLintCellShards } from '../../../index.js';
import { readCellLintBaseline } from '../../../index.js';
import { writeCellLintBaseline } from '../../../index.js';
import { CELL_METRICS } from '../../../index.js';
import { readPathMap } from '../../../index.js';

/** Create the accepted immutable generation and two independent committed-style cell maps. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-cell-shards-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Cell fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Cell fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  /** Commit only a selected cell's independent path-map file. */
  function commit(cell) {
    const file = `packages/codemap/data/plan/path-map/${cell}.json`;
    runFixtureGit(['add', '--', file], { cwd: root, env });
    runFixtureGit(['commit', '-qm', `move ${cell}`], { cwd: root, env });
  }
  /** Accept an existing shard so a later missing file must refuse. */
  function accept(cell) {
    runFixtureGit(['add', '--', `packages/codemap/data/baselines/lints/cells/${cell}.json`], { cwd: root, env });
    runFixtureGit(['commit', '-qm', `accept ${cell} baseline`], { cwd: root, env });
  }
  /** Write one exact fixture file. */
  function put(file, bytes) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), bytes);
  }
  const metrics = Object.fromEntries(CELL_METRICS.map(metric => [metric, { count: 0, allowances: {} }]));
  metrics.legacySource = { count: 2, allowances: { 'src/alpha.js': 1, 'src/beta.js': 1 } };
  metrics.boundaries = { count: 2, allowances: { 'src/alpha.js->src/common.js': 1, 'src/beta.js->src/common.js': 1 } };
  for (const [file, bytes] of cellLintFiles({ version: 1, metrics })) put(file, bytes);
  put('packages/codemap/data/plan/path-map/alpha.json', JSON.stringify({ 'src/alpha.js': 'packages/alpha/src/core/alpha.js' }) + '\n');
  put('packages/codemap/data/plan/path-map/beta.json', JSON.stringify({ 'src/beta.js': 'packages/beta/src/core/beta.js' }) + '\n');
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  initializeCellLintCellShards(root);
  return { root, put, commit, accept, base: readCellLintBaseline(root) };
}

/** Lower only one moved cell's own allowance identities. */
function moved(baseline, cell) {
  const result = structuredClone(baseline);
  delete result.metrics.legacySource.allowances[`src/${cell}.js`];
  delete result.metrics.boundaries.allowances[`src/${cell}.js->src/common.js`];
  result.metrics.legacySource.count--;
  result.metrics.boundaries.count--;
  return result;
}

/** Read the exact two cell shard bytes for a no-shared-file comparison. */
function shards(root) {
  return Object.fromEntries(['alpha', 'beta'].map(cell => [cell,
    readFileSync(join(root, `packages/codemap/data/baselines/lints/cells/${cell}.json`), 'utf8')]));
}

test('two cell moves in either order combine to the same baseline without a shared-file edit [C7,CD64]', t => {
  const first = fixture(t), second = fixture(t);
  const descriptor = readFileSync(join(first.root, 'packages/codemap/data/baselines/lints/index.json'));
  const initial = shards(first.root);
  first.commit('alpha');
  writeCellLintBaseline(first.root, moved(first.base, 'alpha'), { previous: first.base });
  const afterAlpha = shards(first.root);
  assert.notEqual(afterAlpha.alpha, initial.alpha);
  assert.equal(afterAlpha.beta, initial.beta);
  first.commit('beta');
  writeCellLintBaseline(first.root, moved(readCellLintBaseline(first.root), 'beta'), { previous: readCellLintBaseline(first.root) });
  second.commit('beta');
  writeCellLintBaseline(second.root, moved(second.base, 'beta'), { previous: second.base });
  const afterBeta = shards(second.root);
  assert.equal(afterBeta.alpha, initial.alpha);
  assert.notEqual(afterBeta.beta, initial.beta);
  second.commit('alpha');
  writeCellLintBaseline(second.root, moved(readCellLintBaseline(second.root), 'alpha'), { previous: readCellLintBaseline(second.root) });
  assert.deepEqual([...readPathMap(first.root)], [...readPathMap(second.root)]);
  assert.deepEqual(shards(first.root), shards(second.root));
  assert.deepEqual(readCellLintBaseline(first.root), readCellLintBaseline(second.root));
  assert.deepEqual(readFileSync(join(first.root, 'packages/codemap/data/baselines/lints/index.json')), descriptor, 'accepted descriptor stays immutable');
  assert.deepEqual(readFileSync(join(second.root, 'packages/codemap/data/baselines/lints/index.json')), descriptor);
  const beta = join(first.root, 'packages/codemap/data/baselines/lints/cells/beta.json'), original = readFileSync(beta);
  writeFileSync(beta, original.subarray(0, original.length - 2));
  assert.throws(() => readCellLintBaseline(first.root), { code: 'CELL_BASELINE' }, 'a partial cell shard never lowers the ratchet');
});

test('a newly mapped cell has an empty delta until written, while an accepted missing shard refuses [C7,CD64]', t => {
  const box = fixture(t);
  box.commit('alpha');
  box.commit('beta');
  box.put('packages/codemap/data/plan/path-map/gamma.json', JSON.stringify({ 'src/gamma.js': 'packages/gamma/src/core/gamma.js' }) + '\n');
  box.commit('gamma');
  assert.deepEqual(readCellLintBaseline(box.root), box.base, 'a new cell without lowered allowances inherits the immutable baseline');
  writeCellLintBaseline(box.root, box.base, { previous: box.base });
  assert.ok(readFileSync(join(box.root, 'packages/codemap/data/baselines/lints/cells/gamma.json'), 'utf8').includes('"cell": "gamma"'));
  box.accept('alpha');
  rmSync(join(box.root, 'packages/codemap/data/baselines/lints/cells/alpha.json'));
  assert.throws(() => readCellLintBaseline(box.root), { code: 'CELL_BASELINE' }, 'a previously accepted shard cannot silently disappear');
});
