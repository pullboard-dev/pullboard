/** @pullboard-test-input source-cell packages/codemap */
/** Shim lifecycle dates and removal choices come from the selected commit's real first-parent history [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
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
  let day = 0;
  function commit() {
    git('add', '-A');
    const date = new Date(Date.UTC(2001, 0, ++day)).toISOString();
    runFixtureGit(['commit', '-qm', 'fixture history'], { cwd: root, env: { ...process.env,
      GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
      GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com',
      GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    return git('rev-parse', 'HEAD');
  }
  return { root, put, commit, git, remove: path => rmSync(join(root, path)),
    date: commit => git('show', '-s', '--format=%cI', commit) };
}

test('codemap.io-shim-lifecycle.first-parent-date: clause 1: an introduction date comes from the first parent that adds the shim mapping, not a later edit [C7]', t => {
  const repo = history(t);
  const path = 'packages/demo/src/shim.js';
  const map = 'path-map.json';
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
  assert.notEqual(repo.date(introduced), repo.date(selected), 'the real commits have distinct controlled dates');
  assert.equal(repo.git('rev-parse', `${selected}^`), introduced, 'the introduction is on the selected first-parent history');
  repo.put('packages/codemap/data/plan/path-map/demo.json', JSON.stringify({ [path]: 'packages/demo/src/native.js' }) + '\n');
  repo.remove(map);
  const relocated = repo.commit();
  assert.notEqual(repo.date(relocated), repo.date(introduced));
  assert.equal(shimLifecycle(repo.root, { commit: relocated }).find(row => row.path === path)?.moveLandedAt,
    repo.date(introduced), 'moving the same mapping into its cell shard preserves the original introduction date');
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
  assert.deepEqual(shimLifecycle(repo.root).map(row => row.path), [first, later], 'HEAD genuinely contains the later shim');
});

test('codemap.io-shim-lifecycle.removal-item-choice: clause 3: missing and removed shims are excluded and the exact native removal item ranks first [C7]', t => {
  const repo = history(t);
  const kept = 'packages/demo/src/kept.js', missing = 'packages/demo/src/missing.js';
  const map = 'packages/codemap/data/plan/path-map/demo.json';
  repo.put(kept, 'export * from "";\n');
  repo.put(map, JSON.stringify({ [kept]: 'packages/demo/src/native.js', [missing]: 'packages/demo/src/native.js' }) + '\n');
  repo.commit();
  assert.deepEqual(shimLifecycle(repo.root).map(row => row.path), [kept], 'a mapped file that never existed is excluded');
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
  repo.remove(removed);
  const selected = repo.commit();
  assert.deepEqual(shimLifecycle(repo.root, { commit: selected, items }).map(row => row.path), [kept],
    'a formerly present shim is excluded after its real source file is removed');
});
