/** The submit cells check asks Git each fixed question once: local variable names, snapshot reads and base blobs [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  gitChildEnv,
  realGitAdapter,
  withGitContractAdapter,
} from '../../../../git/index.js';
import { createFixtureMemo } from '../../../index.js';
import {
  git,
  readBlobs,
  withCellSourceSnapshots,
} from '../../../src/io/cells/git.js';
import { historyShimReferences } from '../../../src/io/cells/scripts/plan.js';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../../../gate/tests/fixtures/child.js';
import { fixtureCommittedGraph } from '../../../../gate/tests/fixtures/testkit.js';

/** A real Git adapter that records every synchronous Git command it runs. */
function countingGit() {
  const calls = [];
  const adapter = {
    spawnSync(args, options) { calls.push(args); return realGitAdapter.spawnSync(args, options); },
    execFileSync(args, options) { calls.push(args); return realGitAdapter.execFileSync(args, options); },
    spawn(args, options) { calls.push(args); return realGitAdapter.spawn(args, options); },
  };
  return { adapter, calls };
}

/** A committed repository with a file, a folder, two move-history snapshots and a fixture test. */
function repository(t) {
  const graph = fixtureCommittedGraph('cells-git-spawns-');
  const root = graph.root;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  graph.put('a.txt', 'alpha\n');
  graph.put('dir/b.txt', 'beta\n');
  graph.put('packages/state/data/history/1.json', JSON.stringify({ version: 1, engine: 1, declarations: { 'one.js': "import './kept.js';\n" } }));
  graph.put('packages/state/data/history/2.json', JSON.stringify({ version: 1, engine: 2, declarations: { 'two.js': "import '../other/left.js';\n" } }));
  graph.put('test/fixture.test.js', "readFileSync('a.txt');\n");
  const commit = graph.commit();
  const entries = new Map();
  for (const row of runFixtureGit(['ls-tree', '-r', '-z', commit], { cwd: root }).split('\0').filter(Boolean)) {
    const [meta, path] = row.split('\t');
    const [mode, , object] = meta.split(' ');
    entries.set(path, { mode, object });
  }
  return { root, commit, entries };
}

/** Run work inside two virtual snapshot roots of one commit, as the submit check holds main and candidate. */
function inSnapshots(repo, work) {
  const roots = [join(repo.root, '.snapshot-a'), join(repo.root, '.snapshot-b')];
  const snapshots = roots.map(root => ({ root, repoRoot: repo.root, commit: repo.commit, files: new Map(), entries: repo.entries }));
  return withCellSourceSnapshots(snapshots, () => work(roots));
}

test('gitChildEnv asks Git for its local variable names once per adapter and still strips them [C7]', () => {
  const { adapter, calls } = countingGit();
  const files = privateFixtureFiles('cells-git-env-');
  try {
    withGitContractAdapter(adapter, () => {
      for (let index = 0; index < 3; index += 1) {
        const env = gitChildEnv(files.root, { env: { GIT_DIR: '/elsewhere', GIT_INDEX_FILE: '/elsewhere/index' } });
        assert.equal(env.GIT_DIR, undefined);
        assert.equal(env.GIT_INDEX_FILE, undefined);
        assert.equal(env.GIT_NO_REPLACE_OBJECTS, '1');
      }
    });
    assert.equal(calls.filter(args => args.includes('--local-env-vars')).length, 1);
  } finally { rmSync(files.root, { recursive: true, force: true }); }
});

test('a cells snapshot answers rev-parse HEAD and a one-path ls-tree exactly as Git, with no Git process [C7]', t => {
  const repo = repository(t);
  const real = path => runFixtureGit(['ls-tree', '-z', repo.commit, '--', path], { cwd: repo.root });
  const { adapter, calls } = countingGit();
  withGitContractAdapter(adapter, () => inSnapshots(repo, ([root]) => {
    assert.equal(git(root, ['rev-parse', 'HEAD']), repo.commit);
    assert.equal(git(root, ['rev-parse', repo.commit]), repo.commit);
    assert.equal(git(root, ['ls-tree', '-z', repo.commit, '--', 'a.txt']), real('a.txt'));
    assert.equal(git(root, ['ls-tree', '-z', repo.commit, '--', 'missing.txt']), real('missing.txt'));
    assert.equal(calls.length, 0, 'answered reads start no Git process');
    // A folder path is Git's to answer, since snapshot entries hold only files.
    assert.equal(git(root, ['ls-tree', '-z', repo.commit, '--', 'dir']), real('dir'));
    assert.ok(calls.some(args => args.includes('ls-tree')));
  }));
});

test('readBlobs reads several blobs in one Git batch and leaves out an object Git lacks [C7]', t => {
  const repo = repository(t);
  const { adapter, calls } = countingGit();
  const a = repo.entries.get('a.txt').object, b = repo.entries.get('dir/b.txt').object;
  const blobs = withGitContractAdapter(adapter, () => inSnapshots(repo, ([root]) => readBlobs(root, [a, b, a, '0'.repeat(40)])));
  assert.deepEqual([...blobs], [[a, 'alpha\n'], [b, 'beta\n']]);
  assert.equal(calls.filter(args => args.includes('cat-file')).length, 1);
});

test('historyShimReferences reads one base once in one batch for every snapshot root [C7]', t => {
  const repo = repository(t);
  const { adapter, calls } = countingGit();
  withGitContractAdapter(adapter, () => inSnapshots(repo, ([first, second]) => {
    const refs = historyShimReferences(first, repo.commit);
    assert.deepEqual([...refs], [['src/moves/kept.js', 'packages/state/data/history/1.json'], ['src/other/left.js', 'packages/state/data/history/2.json']]);
    assert.equal(historyShimReferences(second, repo.commit), refs);
  }));
  assert.equal(calls.filter(args => args.includes('show')).length, 0);
  assert.equal(calls.filter(args => args.includes('cat-file')).length, 1);
  assert.equal(calls.filter(args => args.includes('ls-tree')).length, 1);
});

test('baseUnsupported reads each base blob from Git once across touched cells [C7]', t => {
  const repo = repository(t);
  const { adapter, calls } = countingGit();
  const memo = createFixtureMemo({
    fixtureSourceEdits: (source, options) => ({ problems: [], edits: [], read: options.readSource('a.txt')?.source }),
    cellsCacheDirectory: () => repo.root, publishCacheEntry: () => {}, analyzerDigest: () => 'test', eligible: () => false,
  });
  withGitContractAdapter(adapter, () => {
    for (let cell = 0; cell < 3; cell += 1) memo.baseUnsupported(repo.root, repo.commit, 'test/fixture.test.js', { moves: [], dataReads: [] });
  });
  const blobReads = calls.filter(args => args.includes('cat-file')).map(args => args.at(-1));
  assert.deepEqual(blobReads.sort(), [repo.entries.get('a.txt').object, repo.entries.get('test/fixture.test.js').object].sort());
});
