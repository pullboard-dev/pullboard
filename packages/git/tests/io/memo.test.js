/** A per-command git memo answers repeated status and untracked scans [C7]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createGitMemo } from '../../src/io/memo.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';

/** A real repository with one commit, and a memo whose runner counts the git processes it spawns. */
function fixture() {
  const files = privateFixtureFiles('git-memo-');
  const root = files.root;
  const run = (cwd, args) => {
    const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
    return { status: out.status, stdout: out.stdout, stderr: out.stderr };
  };
  run(root, ['init', '-q']);
  files.write('a.txt', 'a\n');
  run(root, ['add', 'a.txt']);
  run(root, ['commit', '-q', '-m', 'one']);
  const spawned = [];
  const memo = createGitMemo((cwd, args) => { spawned.push([cwd, args]); return run(cwd, args); });
  return { root, memo, spawned, files };
}

test('the same read-only git call run twice through the memo spawns git once [C7]', () => {
  const { root, files, memo, spawned } = fixture();
  try {
    files.write('new.txt', 'x\n');
    const first = memo.git(root, ['status', '--porcelain']);
    const second = memo.git(root, ['status', '--porcelain']);
    assert.equal(spawned.length, 1);
    assert.deepEqual(second, first);
    assert.match(first.stdout, /new\.txt/u);
    memo.git(root, ['ls-files', '--others', '--exclude-standard']);
    memo.git(root, ['ls-files', '--others', '--exclude-standard']);
    assert.equal(spawned.length, 2);
  } finally { /* the private fixture lives in the temp folder */ }
});

test('a git write through the memo clears it [C7]', () => {
  const { root, files, memo, spawned } = fixture();
  try {
    files.write('b.txt', 'b\n');
    assert.match(memo.git(root, ['status', '--porcelain']).stdout, /b\.txt/u);
    memo.git(root, ['add', 'b.txt']);
    const after = memo.git(root, ['status', '--porcelain']);
    assert.match(after.stdout, /A {2}b\.txt/u);
    assert.equal(spawned.length, 3);
  } finally { /* the private fixture lives in the temp folder */ }
});

test('a different folder or arguments never share a result [C7]', () => {
  const one = fixture();
  const two = fixture();
  try {
    one.files.write('only-one.txt', 'x\n');
    const calls = [];
    const memo = createGitMemo((cwd, args) => { calls.push(cwd); return one.memo.git(cwd, args); });
    const inOne = memo.git(one.root, ['status', '--porcelain']);
    const inTwo = memo.git(two.root, ['status', '--porcelain']);
    const short = memo.git(one.root, ['status', '--short']);
    assert.match(inOne.stdout, /only-one/u);
    assert.equal(inTwo.stdout, '');
    assert.match(short.stdout, /only-one/u);
    assert.equal(calls.length, 3);
  } finally { /* the private fixtures live in the temp folder */ }
});
