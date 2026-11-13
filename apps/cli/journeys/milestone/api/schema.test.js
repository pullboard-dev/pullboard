import { viewApiPorts } from '../../../../view/index.js';
import { apiBoardOpeners } from '../../../tests/fixtures/board.js';
import { openBoard } from '../../../../lib/index.js';
import { copyPackageFiles } from '../../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../tests/fixtures/child.js';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { main } from '../../../tests/fixtures/native.js';
import { refusalDocument } from '../../../index.js';
import { serveApi } from '../../../../../packages/api/index.js';
import { closeBoard } from '../../../../../packages/store/index.js';
import { projectState } from '../../../src/io/view.js';
import { json } from '../../../tests/fixtures/api/project.js';
import { project } from '../../../tests/fixtures/api/project.js';
import { sandbox } from '../../../tests/fixtures/api/project.js';
import { SPEC } from '../../../tests/fixtures/api/project.js';

test('[A5, A6] a future-schema worktree cannot migrate the shared board; main can still upgrade it', () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  const sourceRoot = resolve(import.meta.dirname, '../../../../..');
  mkdirSync(repo);
  copyPackageFiles(sourceRoot, repo);
  writeFileSync(join(repo, 'pullboard.json'), `${JSON.stringify({
    gate: 'true', spec: 'SPEC.md', practice: 'PRACTICE.md',
    lanes: { app: { owns: ['src/'], specs: ['G1'] } }, shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), '# Schema fixture\n\n## G · Goals\n- G1 [approved, must] The board is preserved. | gate: true\n');
  writeFileSync(join(repo, 'PRACTICE.md'), '');
  box.git(repo, 'init', '-q', '-b', 'main');
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up schema fixture');

  /** Run the fixture's own CLI so each worktree imports its committed source. */
  const runFixture = (cwd, ...args) => spawnSync(process.execPath, [join(cwd, 'apps/cli/pullboard.js'), ...args], {
    cwd, env: box.env, encoding: 'utf8',
  });
  const initialized = runFixture(repo, 'status', '--json');
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
  const dbFile = join(repo, '.git', 'pullboard', 'board.sqlite');
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

  const linked = join(box.dir, 'future');
  box.git(repo, 'worktree', 'add', '-q', linked, '-b', 'schema/future');
  assert.equal(box.git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'), box.git(linked, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
  assert.notEqual(box.git(repo, 'rev-parse', '--path-format=absolute', '--git-dir'), box.git(linked, 'rev-parse', '--path-format=absolute', '--git-dir'));

  const olderAgain = new DatabaseSync(dbFile);
  olderAgain.exec('ALTER TABLE item DROP COLUMN item_files; PRAGMA user_version = 1');
  olderAgain.close();
  const mainCodeFromWorktree = spawnSync(process.execPath, [join(repo, 'apps/cli/pullboard.js'), 'join', 'app', '--family', 'codex', '--model', 'fixture-model', '--json'], {
    cwd: linked, env: box.env, encoding: 'utf8',
  });
  assert.equal(mainCodeFromWorktree.status, 0, mainCodeFromWorktree.stderr + mainCodeFromWorktree.stdout);
  const migratedFromWorktree = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(migratedFromWorktree.prepare('PRAGMA user_version').get().user_version, 3, 'the main checkout code may upgrade its shared board even when cwd is a linked worktree');
  assert.ok(migratedFromWorktree.prepare('PRAGMA table_info(item)').all().some((column) => column.name === 'item_files'));
  migratedFromWorktree.close();

  const schemaSource = join(linked, 'packages/store/src/io/board/schema/source.js');
  const migrateSource = join(linked, 'packages/store/src/io/board/migrate.js');
  const oldSource = readFileSync(schemaSource, 'utf8');
  const oldMigrations = readFileSync(migrateSource, 'utf8');
  const migration = "  ['shout', 'shout_request_outcome', \"TEXT NOT NULL DEFAULT ''\"],\n];";
  assert.ok(oldSource.includes('export const SCHEMA_VERSION = 3;'));
  assert.ok(oldMigrations.includes(migration));
  const newSource = oldSource.replace('export const SCHEMA_VERSION = 3;', 'export const SCHEMA_VERSION = 4;');
  const newMigrations = oldMigrations.replace(migration, migration.replace('\n];', "\n  ['item', 'item_unmerged_probe', 'INTEGER NOT NULL DEFAULT 0'],\n];"));
  assert.notEqual(newMigrations, oldMigrations, 'the unmerged worktree carries a real schema-4 migration');
  writeFileSync(schemaSource, newSource);
  writeFileSync(migrateSource, newMigrations);
  box.git(linked, 'add', 'packages/store/src/io/board/schema/source.js', 'packages/store/src/io/board/migrate.js');
  box.git(linked, 'commit', '-q', '-m', 'feat: simulate an unmerged schema bump');

  let before = readFileSync(dbFile);
  const mainGitDir = box.git(repo, 'rev-parse', '--path-format=absolute', '--git-dir');
  const linkedGitDir = box.git(linked, 'rev-parse', '--path-format=absolute', '--git-dir');
  const commonGitDir = box.git(linked, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const inheritedMain = {
    ...box.env, GIT_DIR: mainGitDir, GIT_WORK_TREE: repo, GIT_COMMON_DIR: mainGitDir,
  };
  const inheritedLinked = {
    ...box.env, GIT_DIR: linkedGitDir, GIT_WORK_TREE: linked, GIT_COMMON_DIR: commonGitDir,
  };
  const spoofedWorktree = spawnSync(process.execPath, [join(linked, 'apps/cli/pullboard.js'), 'status', '--json'], {
    cwd: repo, env: inheritedMain, encoding: 'utf8',
  });
  assert.equal(spoofedWorktree.status, 1, spoofedWorktree.stderr + spoofedWorktree.stdout);
  assert.equal(JSON.parse(spoofedWorktree.stdout).error.code, 'UNMERGED_SCHEMA',
    'GIT_DIR pointing at main cannot make unmerged worktree source appear merged');
  assert.deepEqual(readFileSync(dbFile), before, 'inherited main Git variables cannot migrate from worktree source');

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
  before = readFileSync(dbFile);

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
  const relayProbe = join(linked, '.schema-relay-probe.mjs');
  writeFileSync(relayProbe, `
    import { localRecords } from './packages/link/index.js';
    import { openBoard } from './apps/lib/index.js';
    try {
      localRecords(openBoard, process.env.PULLBOARD_FIXTURE_REPO, (board) => board.db.prepare('PRAGMA user_version').get());
      console.log(JSON.stringify({ code: 'UNEXPECTED_OPEN' }));
    } catch (error) {
      console.log(JSON.stringify({ code: error.code, message: error.message }));
    }
  `);
  const relayRecords = spawnSync(process.execPath, [relayProbe], {
    cwd: repo, env: { ...box.env, PULLBOARD_FIXTURE_REPO: repo }, encoding: 'utf8',
  });
  assert.equal(relayRecords.status, 0, relayRecords.stderr + relayRecords.stdout);
  const relayRefusal = JSON.parse(relayRecords.stdout);
  assert.equal(relayRefusal.code, 'UNMERGED_SCHEMA', 'relay localRecords uses its source worktree identity even from main cwd');
  assert.match(relayRefusal.message, /worktree expects board schema 4, newer than the shared board's version 3/);
  assert.deepEqual(readFileSync(dbFile), before, 'relay localRecords refuses before it can migrate the shared board');

  const specCheck = runFixture(linked, 'spec', 'check', '--json');
  assert.equal(specCheck.status, 0, specCheck.stderr + specCheck.stdout);
  assert.deepEqual(readFileSync(dbFile), before, 'spec check reads the spec without opening the shared board');

  const surfaceProbe = join(linked, '.schema-surface-probe.mjs');
  writeFileSync(surfaceProbe, `
    import { serveApi } from './packages/api/index.js'; import { viewApiPorts } from './apps/view/index.js'; import { refusalDocument } from './apps/cli/index.js';
    import { openBoard, openBoardForRead } from './apps/lib/index.js';
    const apiBoardOpeners = { openBoard, openBoardForRead };
    const root = process.env.PULLBOARD_FIXTURE_REPO;
    const project = { root, name: 'schema fixture', project: '', added: '2026-01-01T00:00:00.000Z' };
    const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret: 'api-probe', runCommand: async () => 0, projects: () => [project], isMain: true });
    try {
      const listing = await fetch(api.url).then((response) => response.json());
      console.log(JSON.stringify({
        apiWarnings: listing.warnings?.map((warning) => warning.error.error.code) ?? [],
        apiNext: listing.warnings?.map((warning) => warning.error.error.next) ?? [],
      }));
    } finally {
      await api.close();
    }
  `);
  const surfaces = spawnSync(process.execPath, [surfaceProbe], {
    cwd: linked,
    env: { ...box.env, PULLBOARD_FIXTURE_REPO: repo },
    encoding: 'utf8',
  });
  assert.equal(surfaces.status, 0, surfaces.stderr + surfaces.stdout);
  const surfaceResult = JSON.parse(surfaces.stdout);
  assert.deepEqual(surfaceResult.apiWarnings, ['UNMERGED_SCHEMA'], 'API warnings retain the actionable source-version refusal');
  assert.match(surfaceResult.apiNext[0], /merge this code into the main checkout first/);
  assert.deepEqual(readFileSync(dbFile), before, 'API reads from the linked worktree must not migrate the shared board');

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

  const unguarded = join(box.dir, 'unguarded');
  box.git(repo, 'worktree', 'add', '-q', unguarded, '-b', 'schema/unguarded', 'schema/future');
  const guardedSource = join(unguarded, 'packages/store/src/io/board/sqlite.js');
  const guardedText = readFileSync(guardedSource, 'utf8');
  const unguardedText = guardedText.replace(
    "  isMain = sharedSchemaOwner(file, isMain);",
    '  isMain = true;',
  );
  assert.notEqual(unguardedText, guardedText, 'the mutation removes only the unmerged-schema guard');
  writeFileSync(guardedSource, unguardedText);
  const mutationProbe = join(unguarded, '.schema-mutation-probe.mjs');
  writeFileSync(mutationProbe, `
    import { closeBoard } from './packages/store/index.js';
    import { openBoard } from './apps/lib/index.js';
    const board = openBoard(process.env.PULLBOARD_FIXTURE_BOARD, undefined, { isMain: false });
    closeBoard(board);
  `);
  const mutation = spawnSync(process.execPath, [mutationProbe], {
    cwd: unguarded,
    env: { ...box.env, PULLBOARD_FIXTURE_BOARD: dbFile },
    encoding: 'utf8',
  });
  assert.equal(mutation.status, 0, mutation.stderr + mutation.stdout);
  const mutated = new DatabaseSync(dbFile, { readOnly: true });
  assert.equal(mutated.prepare('PRAGMA user_version').get().user_version, 4,
    'removing the guard makes the linked worktree silently migrate the shared board');
  assert.ok(mutated.prepare('PRAGMA table_info(item)').all().some((column) => column.name === 'item_unmerged_probe'),
    'the guard-removal mutation installs its real schema-4 probe column');
  mutated.close();
});

test('[A2] API projection from a borrowed staged board matches the normal view and leaves it open', () => {
  const box = project();
  json(box, box.repo, 'add', ['app', 'Projection fixture', '--criterion', 'same projector']);
  const board = openBoard(join(box.repo, '.git/pullboard/board.sqlite'));
  try {
    const ordinary = projectState(box.repo);
    const staged = projectState(box.repo, { board });
    // The timeline window is read from the wall clock on each call, so two builds differ by milliseconds.
    const stable = (state) => JSON.parse(JSON.stringify(state, (key, value) => (key === 'since' || key === 'until' ? undefined : value)));
    assert.deepEqual(stable(staged), stable(ordinary), 'the staged path uses the exact API projectState projection');
    assert.doesNotThrow(() => board.db.prepare('SELECT 1').get(), 'the caller retains ownership of its borrowed board connection');
  } finally { closeBoard(board); }
});

