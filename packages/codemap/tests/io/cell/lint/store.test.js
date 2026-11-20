/** @pullboard-test-input source-tree packages/codemap/src/io/cell/lint/shards.js packages/codemap/src/io/cell/lint/store.js packages/codemap/data/plan/path-map/** */
/** The committed cell lint baseline reads back keyed by cell path [C7,CD64]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../../../gate/tests/fixtures/child.js';
import { cellLintFiles } from '../../../../index.js';
import { readCellLintBaseline } from '../../../../index.js';
import { writeCellLintBaseline } from '../../../../index.js';
import { CELL_METRICS } from '../../../../index.js';

/** Build a temp repo with one accepted src/alpha.js allowance and, optionally, a committed path-map shard naming it. */
function fixture(t, mapped, map = { 'src/alpha.js': 'packages/alpha/src/core/alpha.js' }) {
  const { root, write: put } = privateFixtureFiles('pullboard-lint-store-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Store fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Store fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const metrics = Object.fromEntries(CELL_METRICS.map(metric => [metric, { count: 0, allowances: {} }]));
  metrics.legacySource = { count: 2, allowances: { 'src/alpha.js': 2 } };
  if (Object.hasOwn(map, 'src/beta.js')) metrics.legacySource = { count: 3, allowances: { 'src/alpha.js': 2, 'src/beta.js': 1 } };
  metrics.boundaries = { count: 1, allowances: { 'src/alpha.js->src/common.js': 1 } };
  for (const [file, bytes] of cellLintFiles({ version: 1, metrics })) put(file, bytes);
  runFixtureSetupGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  if (mapped) {
    const file = 'packages/codemap/data/plan/path-map/alpha.json';
    put(file, JSON.stringify(map) + '\n');
    runFixtureSetupGit(['add', '--', file], { cwd: root, env });
    runFixtureSetupGit(['commit', '-qm', 'move alpha'], { cwd: root, env });
  }
  return root;
}

test('codemap.io-cell-lint-store.baseline-keys-are-cell-paths: every allowance key reads back as its cell path with unchanged counts, and unchanged without a path-map cell [C7,CD64]', t => {
  const plain = readCellLintBaseline(fixture(t, false));
  assert.deepEqual(Object.keys(plain.metrics.legacySource.allowances), ['src/alpha.js'], 'no path-map cell leaves the baseline as it is');
  const baseline = readCellLintBaseline(fixture(t, true));
  assert.deepEqual({ ...baseline.metrics.legacySource.allowances }, { 'packages/alpha/src/core/alpha.js': 2 });
  assert.deepEqual({ ...baseline.metrics.boundaries.allowances }, { 'packages/alpha/src/core/alpha.js->src/common.js': 1 });
  assert.equal(baseline.metrics.legacySource.count, plain.metrics.legacySource.count);
  assert.equal(baseline.metrics.boundaries.count, plain.metrics.boundaries.count);
});

test('codemap.io-cell-lint-store.writer-takes-cell-keys: a lowered cell-keyed baseline writes, reads back equal and leaves the committed shards in legacy keys, and an ambiguous cell key is refused [C7,CD64]', t => {
  const root = fixture(t, true), before = readCellLintBaseline(root), shard = join(root, 'packages/codemap/data/baselines/lints/cells/alpha.json');
  const lowered = structuredClone(before);
  lowered.metrics.legacySource = { count: 1, allowances: { 'packages/alpha/src/core/alpha.js': 1 } };
  writeCellLintBaseline(root, lowered, { previous: before });
  assert.equal(JSON.stringify(readCellLintBaseline(root)), JSON.stringify(lowered));
  assert.deepEqual(JSON.parse(readFileSync(shard, 'utf8')).metrics.legacySource, { remove: ['src/alpha.js'], allowances: { 'src/alpha.js': 1 } }, 'the shard keeps the legacy key');
  const clash = fixture(t, true, { 'src/alpha.js': 'packages/alpha/src/core/alpha.js', 'src/beta.js': 'packages/alpha/src/core/alpha.js' });
  const base = readCellLintBaseline(clash);
  assert.throws(() => writeCellLintBaseline(clash, structuredClone(base), {}), { code: 'CELL_BASELINE' });
});
