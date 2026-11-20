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
function project(t, moved = 0) {
  const box = privateRepo(t);
  // The submit merge copies the committer identity from this process, so give it the fixture's for the test.
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = box.env[key];
  t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  const quiet = ['-c', 'core.hooksPath=/dev/null'];
  const main = box.root, work = join(box.dir, 'work');
  box.git(...quiet, 'add', '-A'); box.git(...quiet, 'commit', '-q', '-m', 'base');
  box.git('worktree', 'add', '-q', '-b', 'build', work, 'main');
  const git = (dir, ...args) => runFixtureGit(args, { cwd: dir, env: box.env }).trim();
  writeFileSync(join(work, 'builder.txt'), 'builder\n');
  git(work, ...quiet, 'add', '.'); git(work, ...quiet, 'commit', '-q', '-m', 'builder');
  writeFileSync(join(main, 'trunk.txt'), 'main\n');
  for (let n = 0; n < moved; n++) writeFileSync(join(main, `moved-${n}.txt`), `main ${n}\n`);
  git(main, ...quiet, 'add', '-A'); git(main, ...quiet, 'commit', '-q', '-m', 'main');
  const flag = join(box.dir, 'joined');
  const hooks = join(box.dir, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'pre-merge-commit'), `#!/bin/sh\n[ -f '${flag}' ] || { echo 'NOT_JOINED: join a lane' >&2; exit 1; }\n`);
  chmodSync(join(hooks, 'pre-merge-commit'), 0o755);
  git(work, 'config', 'core.hooksPath', hooks);
  return { work, git, flag, trunk: git(main, 'rev-parse', 'HEAD'), source: git(work, 'rev-parse', 'HEAD') };
}

test('cli.journeys-submit-nomerge.a-hook-refusal-after-merging-main: clause 1: a hook refusal after merging main leaves no MERGE_HEAD and no staged changes [C7]', t => {
  const p = project(t);
  assert.throws(() => mergeSubmissionMain(p.work, p.trunk), error => error.code === 'MERGE_CHECK_FAILED' && error.message.includes('NOT_JOINED'));
  assert.equal(existsSync(join(p.git(p.work, 'rev-parse', '--absolute-git-dir'), 'MERGE_HEAD')), false);
  assert.equal(p.git(p.work, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(p.git(p.work, 'rev-parse', 'HEAD'), p.source);
});

test('cli.journeys-submit-nomerge.rerunning-the-submit-merge-after-the: clause 2: rerunning the submit merge after the refusal succeeds without manual cleanup [C7]', t => {
  const p = project(t);
  assert.throws(() => mergeSubmissionMain(p.work, p.trunk), { code: 'MERGE_CHECK_FAILED' });
  writeFileSync(p.flag, 'ok\n');
  const result = mergeSubmissionMain(p.work, p.trunk);
  assert.equal(result.merged, true);
  assert.equal(p.git(p.work, 'status', '--porcelain'), '');
});

test('cli.journeys-submit-nomerge.a-sixty-file-main-merge-leaves-the-folder: clause 1: a submit merge of a 60-file main move, called as submit.js calls it with checkout:false, leaves git status empty and HEAD unchanged [test] [C7]', t => {
  const p = project(t, 60);
  const result = mergeSubmissionMain(p.work, p.trunk, { checkout: false });
  assert.equal(result.merged, true);
  assert.notEqual(result.commit, p.source);
  assert.equal(p.git(p.work, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(p.git(p.work, 'rev-parse', 'HEAD'), p.source);
  assert.equal(existsSync(join(p.work, 'moved-59.txt')), false, 'main files are not written into the folder');
  assert.deepEqual(p.git(p.work, 'show', '-s', '--format=%P', result.commit).split(' '), [p.source, p.trunk]);
});

test('cli.journeys-submit-nomerge.a-second-submit-merge-from-the-same-folder: clause 2: a second submit merge from the same folder is not refused DIRTY and composes the same tree [test] [C7]', t => {
  const p = project(t, 60);
  const first = mergeSubmissionMain(p.work, p.trunk, { checkout: false });
  const second = mergeSubmissionMain(p.work, p.trunk, { checkout: false });
  assert.equal(second.merged, true);
  assert.equal(p.git(p.work, 'rev-parse', `${second.commit}^{tree}`), p.git(p.work, 'rev-parse', `${first.commit}^{tree}`));
  assert.equal(p.git(p.work, 'status', '--porcelain', '--untracked-files=all'), '');
});
