import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../tests/fixtures/child.js';
import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { test } from 'node:test';
import { copyPackageFiles } from '../../../tests/fixtures/copy.js';
import { FIXTURE_MODEL } from '../../../tests/fixtures/child.js';
import { schemaRepo } from '../../../tests/fixtures/api/schema.js';
import { futureWorktree } from '../../../tests/fixtures/api/schema.js';

test('[A5, A6] main source upgrades an older shared board from an installed copy, its own checkout and a linked worktree', () => {
  const fixture = schemaRepo();
  const { box, repo, dbFile, runFixture, sourceRoot } = fixture;
  const prior = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(prior.prepare('PRAGMA user_version').get().user_version, 3);
  prior.close();

  const installed = join(box.dir, 'installed-pullboard');
  mkdirSync(installed);
  copyPackageFiles(sourceRoot, installed);
  const olderInstalled = new DatabaseSync(dbFile);
  olderInstalled.exec('ALTER TABLE item DROP COLUMN item_files; PRAGMA user_version = 1');
  olderInstalled.close();
  const installedRun = spawnSync(process.execPath, [join(installed, 'apps/cli/pullboard.js'), 'shout', 'app', 'board upgrade', '--json'], {
    cwd: repo, env: box.env, encoding: 'utf8',
  });
  assert.equal(installedRun.status, 0, installedRun.stderr + installedRun.stdout);
  const migratedInstalled = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(migratedInstalled.prepare('PRAGMA user_version').get().user_version, 3, 'a copied installed release without Git metadata can upgrade an older board');
  assert.ok(migratedInstalled.prepare('PRAGMA table_info(item)').all().some((column) => column.name === 'item_files'));
  migratedInstalled.close();

  const older = new DatabaseSync(dbFile);
  older.exec('ALTER TABLE item DROP COLUMN item_files; PRAGMA user_version = 1');
  older.close();
  const upgraded = runFixture(repo, 'shout', 'app', 'board upgrade', '--json');
  assert.equal(upgraded.status, 0, upgraded.stderr + upgraded.stdout);
  const migrated = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 3);
  assert.ok(migrated.prepare('PRAGMA table_info(item)').all().some((column) => column.name === 'item_files'));
  migrated.close();

  const linked = futureWorktree(fixture);

  const olderAgain = new DatabaseSync(dbFile);
  olderAgain.exec('ALTER TABLE item DROP COLUMN item_files; PRAGMA user_version = 1');
  olderAgain.close();
  const mainCodeFromWorktree = spawnSync(process.execPath, [join(repo, 'apps/cli/pullboard.js'), 'join', 'app', '--family', 'codex', '--model', FIXTURE_MODEL, '--json'], {
    cwd: linked, env: box.env, encoding: 'utf8',
  });
  assert.equal(mainCodeFromWorktree.status, 0, mainCodeFromWorktree.stderr + mainCodeFromWorktree.stdout);
  const migratedFromWorktree = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(migratedFromWorktree.prepare('PRAGMA user_version').get().user_version, 3, 'the main checkout code may upgrade its shared board even when cwd is a linked worktree');
  assert.ok(migratedFromWorktree.prepare('PRAGMA table_info(item)').all().some((column) => column.name === 'item_files'));
  migratedFromWorktree.close();

  const linkedGitDir = box.git(linked, 'rev-parse', '--path-format=absolute', '--git-dir');
  const commonGitDir = box.git(linked, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const inheritedLinked = {
    ...box.env, GIT_DIR: linkedGitDir, GIT_WORK_TREE: linked, GIT_COMMON_DIR: commonGitDir,
  };
  const olderForHook = new DatabaseSync(dbFile);
  olderForHook.exec('ALTER TABLE item DROP COLUMN item_files; PRAGMA user_version = 1');
  olderForHook.close();
  const mainFromHook = spawnSync(process.execPath, [join(repo, 'apps/cli/pullboard.js'), 'shout', 'app', 'board upgrade', '--json'], {
    cwd: linked, env: inheritedLinked, encoding: 'utf8',
  });
  assert.equal(mainFromHook.status, 0, mainFromHook.stderr + mainFromHook.stdout);
  const upgradedFromHook = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(upgradedFromHook.prepare('PRAGMA user_version').get().user_version, 3, 'main source upgrades even when a linked-worktree hook exports its Git directory');
  upgradedFromHook.close();
});
