/** The git memo resolves the four submit revisions in one spawn and answers repeats from memory [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createGitMemo } from '../../src/io/memo.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';

/** A repository with trunk at one commit and a branch two commits ahead, plus a counting memo. */
function fixture() {
  const files = privateFixtureFiles('git-memo-revs-');
  const root = files.root;
  const run = (cwd, args) => {
    const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr };
  };
  run(root, ['init', '-q', '-b', 'trunk']);
  files.write('a.txt', 'a\n');
  run(root, ['add', '.']);
  run(root, ['commit', '-q', '-m', 'one']);
  run(root, ['checkout', '-q', '-b', 'work']);
  for (const name of ['b', 'c']) {
    files.write(`${name}.txt`, `${name}\n`);
    run(root, ['add', '.']);
    run(root, ['commit', '-q', '-m', name]);
  }
  const spawned = [];
  const memo = createGitMemo((cwd, args) => { spawned.push(args); return run(cwd, args); });
  const rev = ref => run(root, ['rev-parse', ref]).stdout.trim();
  return { root, memo, spawned, rev };
}

test('git.memo-revs.single-spawn: resolveRevs spawns git once for HEAD, HEAD^, trunk and the merge base [C7]', () => {
  const { root, memo, spawned, rev } = fixture();
  const got = memo.resolveRevs(root, 'trunk');
  assert.equal(spawned.length, 1);
  assert.deepEqual(got, { ok: true, head: rev('HEAD'), parent: rev('HEAD^'), trunk: rev('trunk'), mergeBase: rev('trunk') });
});

test('git.memo-revs.repeat-reads: a repeated resolveRevs call and a repeated first-parent log read each spawn at most once [C7]', () => {
  const { root, memo, spawned } = fixture();
  memo.resolveRevs(root, 'trunk');
  memo.resolveRevs(root, 'trunk');
  assert.equal(spawned.length, 1);
  const first = memo.git(root, ['log', '--first-parent', '--format=%H', 'trunk..HEAD']);
  const second = memo.git(root, ['log', '--first-parent', '--format=%H', 'trunk..HEAD']);
  assert.equal(spawned.length, 2);
  assert.deepEqual(second, first);
  memo.git(root, ['commit', '--allow-empty', '-q', '-m', 'd']);
  assert.notEqual(memo.resolveRevs(root, 'trunk').head, undefined);
  assert.equal(spawned.length, 4);
});
