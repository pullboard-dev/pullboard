/** Real merge indexes prove exact foreign-object preservation without weakening lane ownership [L3]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaults } from '../src/config.js';
import { preCommitProblems } from '../src/hooks.js';

/** Run private Git with an explicit fixture identity, retaining only nonsensitive diagnostics. */
function git(root, ...args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', env: {
    ...process.env, GIT_AUTHOR_NAME: 'Merge Fixture', GIT_AUTHOR_EMAIL: 'merge@example.invalid',
    GIT_COMMITTER_NAME: 'Merge Fixture', GIT_COMMITTER_EMAIL: 'merge@example.invalid',
  } });
  assert.equal(result.status, 0, 'fixture git ' + args[0] + ': ' + result.stderr);
  return result.stdout.trim();
}

/** Make separate main and lane checkouts with committed policy and two owned files. */
function fixture(t, branch = 'main') {
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard-merge-hook-'));
  const main = join(scratch, 'main');
  const lane = join(scratch, 'lane');
  mkdirSync(main);
  const config = { ...defaults(), lanes: { core: { owns: ['core/'], specs: ['L'] }, view: { owns: ['view/'], specs: ['L'] } }, shared: [] };
  git(main, 'init', '-q', '-b', branch);
  git(main, 'config', 'user.name', 'Merge Fixture');
  git(main, 'config', 'user.email', 'merge@example.invalid');
  for (const folder of ['core', 'view']) mkdirSync(join(main, folder));
  writeFileSync(join(main, 'pullboard.json'), JSON.stringify(config));
  writeFileSync(join(main, 'core', 'file'), 'base core\n');
  writeFileSync(join(main, 'view', 'file'), 'base view\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'test: seed private merge fixture');
  git(main, 'worktree', 'add', '-q', '-b', 'core/fixture', lane);
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  return { main, lane, config, context: { root: lane, isMain: false, config, agent: { agent_lane: 'core' } } };
}

/** Commit one lane-owned edit and one main-owned edit to force a real pending merge. */
function diverge(box, { conflict = false } = {}) {
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  git(box.lane, 'add', '-A');
  git(box.lane, 'commit', '-q', '-m', 'test: lane change');
  writeFileSync(join(box.main, 'view', 'file'), 'accepted view\n');
  if (conflict) writeFileSync(join(box.main, 'core', 'file'), 'accepted core\n');
  git(box.main, 'add', '-A');
  git(box.main, 'commit', '-q', '-m', 'test: accepted main change');
  const result = spawnSync('git', ['merge', '--no-commit', '--no-ff', git(box.main, 'rev-parse', 'HEAD')], { cwd: box.lane, encoding: 'utf8' });
  assert.equal(result.status, conflict ? 1 : 0, 'a real merge is pending');
}

test('accepted-main merges preserve exact foreign objects on a primary branch named trunk [L3]', (t) => {
  const box = fixture(t, 'trunk');
  diverge(box);
  assert.deepEqual(preCommitProblems(box.context), []);
  git(box.lane, 'commit', '-q', '-m', 'test: merge accepted main');
  writeFileSync(join(box.lane, 'view', 'file'), 'outside a merge\n');
  git(box.lane, 'add', '-A');
  assert.ok(preCommitProblems(box.context).some((problem) => problem.includes('outside the core lane: view/file')),
    'the exception ends when the merge ends');
});

test('owned conflict resolutions commit while foreign edits and mode changes remain refused [L3]', (t) => {
  const box = fixture(t);
  diverge(box, { conflict: true });
  writeFileSync(join(box.lane, 'core', 'file'), 'resolved owned core\n');
  git(box.lane, 'add', 'core/file');
  assert.deepEqual(preCommitProblems(box.context), []);
  writeFileSync(join(box.lane, 'view', 'file'), 'sneaked foreign edit\n');
  git(box.lane, 'add', 'view/file');
  assert.ok(preCommitProblems(box.context).some((problem) => problem.includes('view/file')));
  git(box.lane, 'restore', '--source=MERGE_HEAD', '--staged', '--worktree', '--', 'view/file');
  git(box.lane, 'update-index', '--chmod=+x', 'view/file');
  assert.ok(preCommitProblems(box.context).some((problem) => problem.includes('view/file')),
    'an unchanged blob does not authorize a different executable mode');
});

test('a foreign resolution identical to HEAD is allowed, including literal odd filenames [L3]', (t) => {
  const box = fixture(t);
  const path = 'view/literal [x] \n file';
  writeFileSync(join(box.main, path), 'base literal\n');
  git(box.main, 'add', '-A');
  git(box.main, 'commit', '-q', '-m', 'test: add literal fixture path');
  git(box.lane, 'merge', '--ff-only', 'main');
  writeFileSync(join(box.lane, path), 'existing lane parent\n');
  git(box.lane, 'add', '-A');
  git(box.lane, 'commit', '-q', '-m', 'test: prior foreign parent fixture');
  writeFileSync(join(box.main, path), 'accepted other parent\n');
  git(box.main, 'add', '-A');
  git(box.main, 'commit', '-q', '-m', 'test: alternate accepted parent');
  const result = spawnSync('git', ['merge', '--no-commit', '--no-ff', 'main'], { cwd: box.lane, encoding: 'utf8' });
  assert.equal(result.status, 1, 'foreign parents conflict');
  assert.ok(preCommitProblems(box.context).some((problem) => problem.includes('literal')),
    'unresolved stages are never treated as an absent path');
  git(box.lane, 'restore', '--source=HEAD', '--staged', '--worktree', '--', path);
  assert.deepEqual(preCommitProblems(box.context), []);
  writeFileSync(join(box.lane, path), 'neither parent\n');
  git(box.lane, 'add', '--', path);
  assert.ok(preCommitProblems(box.context).some((problem) => problem.includes('literal')),
    'a new foreign object is refused without interpreting brackets or line breaks');
});

test('merging an unaccepted branch never authorizes foreign changes [L3]', (t) => {
  const box = fixture(t);
  writeFileSync(join(box.lane, 'core', 'file'), 'lane core\n');
  git(box.lane, 'add', '-A');
  git(box.lane, 'commit', '-q', '-m', 'test: diverge lane');
  git(box.main, 'branch', 'unaccepted');
  const other = join(box.main, '..', 'other');
  git(box.main, 'worktree', 'add', '-q', other, 'unaccepted');
  writeFileSync(join(other, 'view', 'file'), 'unaccepted foreign\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-q', '-m', 'test: unaccepted branch');
  git(box.lane, 'merge', '--no-commit', '--no-ff', 'unaccepted');
  assert.ok(preCommitProblems(box.context).some((problem) => problem.includes('view/file')));
});
