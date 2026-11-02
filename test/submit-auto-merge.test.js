/** Exact clean source composition and named conflict without fabricated edits [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from './fixture-child.js';
import { mergeSubmissionMain } from '../packages/merge/index.js';

/** Real worktree with independent builder and main changes. */
function project(t, conflict = false) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-auto-merge-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const main = join(root, 'main'), work = join(root, 'work');
  mkdirSync(main);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Builder', GIT_AUTHOR_EMAIL: 'builder@example.invalid',
    GIT_COMMITTER_NAME: 'Builder', GIT_COMMITTER_EMAIL: 'builder@example.invalid' };
  const git = (dir, ...args) => runFixtureGit(args, { cwd: dir, env }).trim();
  writeFileSync(join(main, 'shared.txt'), 'base\n');
  git(main, 'init', '-q', '-b', 'main'); git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'base');
  git(main, 'worktree', 'add', '-q', '-b', 'build', work, 'main');
  writeFileSync(join(work, conflict ? 'shared.txt' : 'builder.txt'), 'builder\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'builder');
  const source = git(work, 'rev-parse', 'HEAD');
  writeFileSync(join(main, conflict ? 'shared.txt' : 'trunk.txt'), 'main\n');
  git(main, 'add', '.'); git(main, 'commit', '-q', '-m', 'main');
  return { main, work, git, source, trunk: git(main, 'rev-parse', 'HEAD') };
}

test('a clean main move creates exactly the builder-attributed merge tree [C7,V4]', t => {
  const p = project(t), expected = p.git(p.work, 'merge-tree', '--write-tree', p.source, p.trunk).split('\n')[0];
  const result = mergeSubmissionMain(p.work, p.trunk);
  assert.equal(result.source, p.source); assert.equal(result.merged, true);
  assert.equal(p.git(p.work, 'rev-parse', 'HEAD^{tree}'), expected);
  assert.deepEqual(p.git(p.work, 'show', '-s', '--format=%P', result.commit).split(' '), [p.source, p.trunk]);
  assert.equal(p.git(p.work, 'show', '-s', '--format=%an <%ae>', result.commit), 'Builder <builder@example.invalid>');
  assert.equal(p.git(p.work, 'status', '--porcelain'), '');
  assert.equal(mergeSubmissionMain(p.work, p.trunk).merged, false);
});

test('a conflicting main move names the file and leaves the source untouched [C7,V4]', t => {
  const p = project(t, true);
  assert.throws(() => mergeSubmissionMain(p.work, p.trunk), error => error.code === 'MERGE_CONFLICT' && error.message.includes('shared.txt'));
  assert.equal(p.git(p.work, 'rev-parse', 'HEAD'), p.source);
  assert.equal(p.git(p.work, 'status', '--porcelain'), '');
});
