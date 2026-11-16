/** A submit whose main merge is refused by a hook leaves the item folder clean, and a rerun succeeds [C7]. */
import assert from 'node:assert/strict';
import { chmodSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../packages/gate/tests/fixtures/child.js';
import { privateRepo } from '../../tests/fixtures/submit/gate.js';
import { mergeSubmissionMain } from '../../../../packages/merge/index.js';

/** A private repo with independent builder and main changes, plus a pre-merge-commit hook that refuses until a flag file exists. */
function project(t) {
  const box = privateRepo(t);
  const quiet = ['-c', 'core.hooksPath=/dev/null'];
  const main = box.root, work = join(box.dir, 'work');
  box.git(...quiet, 'add', '-A'); box.git(...quiet, 'commit', '-q', '-m', 'base');
  box.git('worktree', 'add', '-q', '-b', 'build', work, 'main');
  const git = (dir, ...args) => runFixtureGit(args, { cwd: dir, env: box.env }).trim();
  writeFileSync(join(work, 'builder.txt'), 'builder\n');
  git(work, ...quiet, 'add', '.'); git(work, ...quiet, 'commit', '-q', '-m', 'builder');
  writeFileSync(join(main, 'trunk.txt'), 'main\n');
  git(main, ...quiet, 'add', 'trunk.txt'); git(main, ...quiet, 'commit', '-q', '-m', 'main');
  const flag = join(box.dir, 'joined');
  const hooks = join(box.dir, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-merge-commit'), `#!/bin/sh\n[ -f '${flag}' ] || { echo 'NOT_JOINED: join a lane' >&2; exit 1; }\n`);
  chmodSync(join(hooks, 'pre-merge-commit'), 0o755);
  git(work, 'config', 'core.hooksPath', hooks);
  return { work, git, flag, trunk: git(main, 'rev-parse', 'HEAD'), source: git(work, 'rev-parse', 'HEAD') };
}

test('clause 1: a hook refusal after merging main leaves no MERGE_HEAD and no staged changes [C7]', t => {
  const p = project(t);
  assert.throws(() => mergeSubmissionMain(p.work, p.trunk), error => error.code === 'MERGE_CHECK_FAILED' && error.message.includes('NOT_JOINED'));
  assert.equal(existsSync(join(p.git(p.work, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD')), false);
  assert.equal(p.git(p.work, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(p.git(p.work, 'rev-parse', 'HEAD'), p.source);
});

test('clause 2: rerunning the submit merge after the refusal succeeds without manual cleanup [C7]', t => {
  const p = project(t);
  assert.throws(() => mergeSubmissionMain(p.work, p.trunk), { code: 'MERGE_CHECK_FAILED' });
  writeFileSync(p.flag, 'ok\n');
  const result = mergeSubmissionMain(p.work, p.trunk);
  assert.equal(result.merged, true);
  assert.equal(p.git(p.work, 'status', '--porcelain'), '');
});
