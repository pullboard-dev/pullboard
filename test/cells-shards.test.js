/** @pullboard-test-input source-tree src/cell-lint-cell-shards.js src/cell-lint-store.js bin/cells-plan/path-map/** */
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
import { runFixtureGit } from './fixture-child.js';
import { cellLintFiles } from '../src/cell-lint-store.js';
import { initializeCellLintCellShards } from '../src/cell-lint-store.js';
import { readCellLintBaseline } from '../src/cell-lint-store.js';
import { writeCellLintBaseline } from '../src/cell-lint-store.js';
import { CELL_METRICS } from '../src/cell-lints.js';
import { readPathMap } from '../src/path-map.js';

/** Create the accepted immutable generation and two independent committed-style cell maps. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-cell-shards-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  /** Commit only a selected cell's independent path-map file. */
  function commit(cell) {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Cell fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Cell fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
    const file = `bin/cells-plan/path-map/${cell}.json`;
    runFixtureGit(['add', '--', file], { cwd: root, env });
    runFixtureGit(['commit', '-qm', `move ${cell}`], { cwd: root, env });
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
  put('bin/cells-plan/path-map/alpha.json', JSON.stringify({ 'src/alpha.js': 'packages/alpha/src/core/alpha.js' }) + '\n');
  put('bin/cells-plan/path-map/beta.json', JSON.stringify({ 'src/beta.js': 'packages/beta/src/core/beta.js' }) + '\n');
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  initializeCellLintCellShards(root);
  return { root, commit, base: readCellLintBaseline(root) };
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
    readFileSync(join(root, `bin/cell-lint-baselines/cells/${cell}.json`), 'utf8')]));
}

test('two cell moves in either order combine to the same baseline without a shared-file edit [C7,CD64]', t => {
  const first = fixture(t), second = fixture(t);
  const descriptor = readFileSync(join(first.root, 'bin/cell-lint-baselines/index.json'));
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
  assert.deepEqual(readFileSync(join(first.root, 'bin/cell-lint-baselines/index.json')), descriptor, 'accepted descriptor stays immutable');
  assert.deepEqual(readFileSync(join(second.root, 'bin/cell-lint-baselines/index.json')), descriptor);
  const beta = join(first.root, 'bin/cell-lint-baselines/cells/beta.json'), original = readFileSync(beta);
  writeFileSync(beta, original.subarray(0, original.length - 2));
  assert.throws(() => readCellLintBaseline(first.root), { code: 'CELL_BASELINE' }, 'a partial cell shard never lowers the ratchet');
});
