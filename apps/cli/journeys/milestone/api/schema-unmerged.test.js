import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../tests/fixtures/child.js';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { schemaRepo } from '../../../tests/fixtures/api/schema.js';
import { futureWorktree } from '../../../tests/fixtures/api/schema.js';

test('[A5, A6] a future-schema worktree is refused every way it is run and leaves the shared board byte-for-byte', () => {
  const fixture = schemaRepo();
  const { box, repo, dbFile, runFixture } = fixture;
  const linked = futureWorktree(fixture);
  const before = readFileSync(dbFile);
  const mainGitDir = box.git(repo, 'rev-parse', '--path-format=absolute', '--git-dir');
  const inheritedMain = {
    ...box.env, GIT_DIR: mainGitDir, GIT_WORK_TREE: repo, GIT_COMMON_DIR: mainGitDir,
  };
  const spoofedWorktree = spawnSync(process.execPath, [join(linked, 'apps/cli/pullboard.js'), 'status', '--json'], {
    cwd: repo, env: inheritedMain, encoding: 'utf8',
  });
  assert.equal(spoofedWorktree.status, 1, spoofedWorktree.stderr + spoofedWorktree.stdout);
  assert.equal(JSON.parse(spoofedWorktree.stdout).error.code, 'UNMERGED_SCHEMA',
    'GIT_DIR pointing at main cannot make unmerged worktree source appear merged');
  assert.deepEqual(readFileSync(dbFile), before, 'inherited main Git variables cannot migrate from worktree source');

  const worktreeCodeFromMain = spawnSync(process.execPath, [join(linked, 'apps/cli/pullboard.js'), 'status', '--json'], {
    cwd: repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(worktreeCodeFromMain.status, 1, worktreeCodeFromMain.stderr + worktreeCodeFromMain.stdout);
  assert.equal(JSON.parse(worktreeCodeFromMain.stdout).error.code, 'UNMERGED_SCHEMA',
    'a future-schema worktree refuses migration even when invoked from the main checkout directory');
  assert.deepEqual(readFileSync(dbFile), before, 'cwd cannot make worktree code migrate the shared board');

  const initFromMain = spawnSync(process.execPath, [join(linked, 'apps/cli/pullboard.js'), 'init', '--json'], {
    cwd: repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(initFromMain.status, 1, initFromMain.stderr + initFromMain.stdout);
  assert.equal(JSON.parse(initFromMain.stdout).error.code, 'UNMERGED_SCHEMA',
    'the setup command uses the running source identity when it opens the board');
  assert.deepEqual(readFileSync(dbFile), before, 'setup cannot migrate the shared board from unmerged code');

  const envBypass = spawnSync(process.execPath, [join(linked, 'apps/cli/pullboard.js'), 'status', '--json'], {
    cwd: repo, env: { ...box.env, PULLBOARD_CODE_IS_MAIN: '1' }, encoding: 'utf8',
  });
  assert.equal(envBypass.status, 1, envBypass.stderr + envBypass.stdout);
  assert.equal(JSON.parse(envBypass.stdout).error.code, 'UNMERGED_SCHEMA',
    'PULLBOARD_CODE_IS_MAIN cannot impersonate main-checkout source provenance');
  assert.deepEqual(readFileSync(dbFile), before, 'the removed environment override cannot migrate the shared board');
  const specCheck = runFixture(linked, 'spec', 'check', '--json');
  assert.equal(specCheck.status, 0, specCheck.stderr + specCheck.stdout);
  assert.deepEqual(readFileSync(dbFile), before, 'spec check reads the spec without opening the shared board');

  const refused = runFixture(linked, 'status', '--json');
  assert.equal(refused.status, 1, refused.stderr + refused.stdout);
  assert.equal(refused.stderr, '');
  const document = JSON.parse(refused.stdout);
  assert.equal(document.error.code, 'UNMERGED_SCHEMA');
  assert.match(document.error.message, /worktree expects board schema 4, newer than the shared board's version 3/);
  assert.match(document.error.next, /merge this code into the main checkout first, or test it against a throwaway board/);
  assert.deepEqual(readFileSync(dbFile), before, 'the newer branch must leave every shared-board byte alone');
  const unchanged = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 3);
  assert.equal(unchanged.prepare('PRAGMA table_info(item)').all().some((column) => column.name === 'item_unmerged_probe'), false,
    'the branch migration would have installed this column without the refusal');
  unchanged.close();

});
