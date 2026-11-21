/** @pullboard-test-input source-cell packages/codemap */
/** Shim lifecycle dates and removal choices come from the selected commit's real first-parent history [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';
import { shimLifecycle } from '../../../src/io/shim/lifecycle.js';

/** Make dated commits in a private repository so the lifecycle reader sees ordinary Git history. */
function history(t) {
  const graph = fixtureCommittedGraph('codemap-shim-lifecycle-');
  const { root } = graph;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => runFixtureGit(args, { cwd: root, encoding: 'utf8' }).trim();
  function put(path, body) {
    graph.put(path, body);
  }
  function commit() {
    git('add', '-A');
    git('commit', '-qm', 'fixture history');
    return git('rev-parse', 'HEAD');
  }
  return { root, put, commit, date: commit => git('show', '-s', '--format=%cI', commit) };
}

test('codemap.io-shim-lifecycle.first-parent-date: clause 1: an introduction date comes from the first parent that adds the shim mapping, not a later edit [C7]', t => {
  const repo = history(t);
  const path = 'packages/demo/src/shim.js';
  const map = 'packages/codemap/data/plan/path-map/demo.json';
  repo.put(path, 'export * from "";\n');
  repo.put(map, '{}\n');
  repo.commit();
  repo.put(map, JSON.stringify({ [path]: 'packages/demo/src/native.js' }) + '\n');
  const introduced = repo.commit();
  repo.put(path, 'export * from "";\n// later source edit\n');
  const selected = repo.commit();
  const result = shimLifecycle(repo.root, { commit: selected });
  assert.equal(result.find(row => row.path === path)?.moveLandedAt, repo.date(introduced));
  assert.notEqual(introduced, selected);
});

test('codemap.io-shim-lifecycle.exact-selected-commit: clause 2: lifecycle reads only the explicitly selected commit and excludes later shims [C7]', t => {
  const repo = history(t);
  const first = 'packages/demo/src/first.js', later = 'packages/demo/src/later.js';
  const map = 'packages/codemap/data/plan/path-map/demo.json';
  repo.put(first, 'export * from "";\n');
  repo.put(map, JSON.stringify({ [first]: 'packages/demo/src/native.js' }) + '\n');
  const selected = repo.commit();
  repo.put(later, 'export * from "";\n');
  repo.put(map, JSON.stringify({ [first]: 'packages/demo/src/native.js', [later]: 'packages/demo/src/native.js' }) + '\n');
  repo.commit();
  assert.deepEqual(shimLifecycle(repo.root, { commit: selected }).map(row => row.path), [first]);
});

test('codemap.io-shim-lifecycle.removal-item-choice: clause 3: missing and removed shims are excluded and the exact native removal item ranks first [C7]', t => {
  const repo = history(t);
  const kept = 'packages/demo/src/kept.js', missing = 'packages/demo/src/missing.js';
  const map = 'packages/codemap/data/plan/path-map/demo.json';
  repo.put(kept, 'export * from "";\n');
  repo.put(map, JSON.stringify({ [kept]: 'packages/demo/src/native.js', [missing]: 'packages/demo/src/native.js' }) + '\n');
  repo.commit();
  const removed = 'packages/demo/src/removed.js';
  repo.put(removed, 'export * from "";\n');
  repo.put(map, JSON.stringify({ [kept]: 'packages/demo/src/native.js', [removed]: 'packages/demo/src/native.js' }) + '\n');
  repo.commit();
  const items = [
    { item_id: 10, item_title: 'remove shim', item_criterion: kept, item_status: 'open' },
    { item_id: 11, item_title: 'remove shim', item_criterion: kept, item_status: 'verified' },
    { item_id: 12, item_title: 'remove shim in demo', item_criterion: '', item_status: 'open' },
  ];
  const result = shimLifecycle(repo.root, { items });
  assert.deepEqual(result.map(row => row.path), [kept, removed]);
  assert.equal(result[0].removalItem, 10);
  assert.equal(result[1].removalItem, 12);
});
