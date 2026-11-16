/** reviewFolder fetches a trunk-only commit into a detached worktree and reuses it on a second call [C7,#3091]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { test } from 'node:test';
import { reviewFolder } from '../../src/io/review-folder.js';
import { privateFixtureFiles } from '../../../../apps/cli/tests/fixtures/child.js';

const run = (cwd, args) => {
  const out = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return out.stdout.trim();
};

/** A trunk bare repo, a builder clone that pushes one commit to it, and a reviewer clone that never saw that commit. */
function fixture() {
  const files = privateFixtureFiles('review-folder-');
  const trunk = `${files.root}/trunk.git`;
  const builder = `${files.root}/builder`;
  const reviewer = `${files.root}/reviewer`;
  run(files.root, ['init', '-q', '--bare', trunk]);
  run(files.root, ['clone', '-q', trunk, builder]);
  files.write('builder/a.txt', 'one\n');
  run(builder, ['add', 'a.txt']);
  run(builder, ['commit', '-q', '-m', 'one']);
  run(builder, ['push', '-q', 'origin', 'HEAD:refs/heads/main']);
  run(files.root, ['clone', '-q', trunk, reviewer]);
  files.write('builder/b.txt', 'two\n');
  run(builder, ['add', 'b.txt']);
  run(builder, ['commit', '-q', '-m', 'two']);
  run(builder, ['push', '-q', 'origin', 'HEAD:refs/heads/submitted']);
  return { trunk, reviewer, commit: run(builder, ['rev-parse', 'HEAD']) };
}

test('clause 1: a commit only the trunk remote holds is fetched and checked out in a detached worktree [C7,#3091]', () => {
  const { trunk, reviewer, commit } = fixture();
  assert.notEqual(spawnSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: reviewer }).status, 0, 'the reviewer clone lacks the commit');
  const { folder, reused } = reviewFolder(reviewer, commit, { remote: trunk });
  assert.equal(reused, false);
  assert.equal(run(folder, ['rev-parse', 'HEAD']), commit);
  assert.equal(run(folder, ['symbolic-ref', '-q', 'HEAD']).length, 0, 'HEAD is detached');
  assert.match(run(reviewer, ['worktree', 'list', '--porcelain']), new RegExp(realpathSync(folder).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
});

test('clause 2: a second call for the same commit reuses that folder instead of creating another [C7,#3091]', () => {
  const { trunk, reviewer, commit } = fixture();
  const first = reviewFolder(reviewer, commit, { remote: trunk });
  const second = reviewFolder(reviewer, commit, { remote: trunk });
  assert.equal(second.folder, first.folder);
  assert.equal(second.reused, true);
  assert.equal(run(reviewer, ['worktree', 'list', '--porcelain']).split('\n').filter(line => line.startsWith('worktree ')).length, 2, 'the clone and one review folder');
});
