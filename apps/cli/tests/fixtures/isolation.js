/** Private-Git regression helper for a branch source whose unversioned DDL must not install [A5,A6,C7]. */
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Run an isolated fixture command and retain both streams for a precise assertion. */
function run(command, args, cwd, env) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8' });
}

/**
 * Create a real branch worktree with a same-version DDL/trigger delta and exercise shared-board operations.
 * Returns the combined stdout and stderr of the branch's status read and claim so a caller can count diagnostics.
 */
export async function assertBranchWorktreeBoardIsolation(t, sourceRoot) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-branch-board-isolation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  const branch = join(directory, 'branch');
  mkdirSync(repo);
  copyPackageFiles(sourceRoot, repo);
  writeFileSync(join(repo, 'pullboard.json'), `${JSON.stringify({
    gate: 'true', spec: 'SPEC.md', practice: 'PRACTICE.md',
    lanes: { web: { owns: ['web/'], specs: [] } }, shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(repo, 'SPEC.md'), '# Worktree schema fixture\n\n## G · Goals\n- G1 [approved, must] Keep the shared board stable. | gate: true\n');
  writeFileSync(join(repo, 'PRACTICE.md'), '');
  const env = { ...process.env,
    HOME: join(directory, 'home'), PULLBOARD_FIXTURE_BOARD: '1', PULLBOARD_HOME: join(directory, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(directory, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Board Isolation Fixture', GIT_AUTHOR_EMAIL: 'board-isolation@example.test',
    GIT_COMMITTER_NAME: 'Board Isolation Fixture', GIT_COMMITTER_EMAIL: 'board-isolation@example.test',
  };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_') && !name.startsWith('GIT_CONFIG_')
      && !name.startsWith('GIT_AUTHOR_') && !name.startsWith('GIT_COMMITTER_')) delete env[name];

  /** Execute a real private Git operation without bypassing installed hooks. */
  const gitAt = (cwd, ...args) => {
    const result = run('git', args, cwd, env);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout.trim();
  };
  /** Use the primary private repository for setup. */
  const git = (...args) => gitAt(repo, ...args);
  /** Run the chosen checkout's real command in a fresh process. */
  const cli = (cwd, ...args) => run(process.execPath,
    [join(cwd, 'apps/cli/pullboard.js'), ...args, '--json'], cwd, env);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore: initialize board isolation fixture');

  const linked = run('git', ['worktree', 'add', '-q', '-b', 'schema/drift', branch, 'main'], repo, env);
  assert.equal(linked.status, 0, linked.stderr + linked.stdout);
  const missing = cli(branch, 'status');
  assert.equal(missing.status, 1, missing.stderr + missing.stdout);
  assert.equal(JSON.parse(missing.stdout).error.code, 'UNMERGED_SCHEMA', 'branch source still cannot initialize its own missing shared board');
  assert.equal(existsSync(join(repo, '.git', 'pullboard', 'board.sqlite')), false, 'the refused open creates no shared database');
  const initialized = cli(repo, 'init');
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
  const joined = cli(branch, 'join', 'web', '--model', 'fixture-worker', '--route', 'strong');
  assert.equal(joined.status, 0, joined.stderr + joined.stdout);
  const joinedDocument = JSON.parse(joined.stdout);
  const added = cli(repo, 'add', 'web', 'shared schema fixture item', '--criterion', 'the branch claim uses the shared board');
  assert.equal(added.status, 0, added.stderr + added.stdout);
  const itemId = JSON.parse(added.stdout).item.item_id;

  const boardFile = join(repo, '.git', 'pullboard', 'board.sqlite');
  /** Observe persistent DDL and ordinary effects through a read-only connection. */
  const footprint = () => {
    const db = new DatabaseSync(boardFile, { readOnly: true });
    try {
      return {
        schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
        schemaCookie: db.prepare('PRAGMA schema_version').get().schema_version,
        itemColumns: db.prepare('PRAGMA table_info(item)').all().map(column => column.name),
        schemaObjects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(),
        triggers: db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine%' ORDER BY name").all(),
        item: db.prepare('SELECT item_id, item_status, item_owner FROM item WHERE item_id=?').get(itemId),
        eventCount: db.prepare('SELECT count(*) AS n FROM event').get().n,
      };
    } finally { db.close(); }
  };
  const before = footprint();

  const boardFileInBranch = join(branch, 'packages/store/src/io/board/schema/source.js');
  const boardSource = readFileSync(boardFileInBranch, 'utf8');
  // The added-column list lives in board-migrate.js; schema versions live in board-schema-source.js.
  const migrateFileInBranch = join(branch, 'packages/store/src/io/board/migrate.js');
  const migrateSource = readFileSync(migrateFileInBranch, 'utf8');
  const migration = "  ['item', 'item_after', \"TEXT NOT NULL DEFAULT ''\"],";
  assert.ok(migrateSource.includes(migration), 'the candidate source contains the stable migration insertion point');
  assert.match(boardSource, /export const SCHEMA_VERSION = \d+;/u);
  assert.match(boardSource, /export const EVENT_LOG_VERSION = \d+;/u);
  const branchBoardSource = migrateSource.replace(migration,
    `${migration}\n  ['item', 'item_branch_probe', \"TEXT NOT NULL DEFAULT ''\"],`);
  assert.notEqual(branchBoardSource, migrateSource);
  writeFileSync(migrateFileInBranch, branchBoardSource);

  const machineFileInBranch = join(branch, 'packages/state/src/io/machine.js');
  const machineSource = readFileSync(machineFileInBranch, 'utf8');
  const triggerBody = "refuse('UNDECLARED_MOVE', `the moves are ${moves.join(', ')}`)";
  const branchTriggerBody = "refuse('UNDECLARED_MOVE', `branch fixture moves are ${moves.join(', ')}`)";
  assert.ok(machineSource.includes(triggerBody), 'the candidate machine source contains the named move-trigger clause');
  writeFileSync(machineFileInBranch, machineSource.replace(triggerBody, branchTriggerBody));
  const commonMain = gitAt(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const commonBranch = gitAt(branch, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  const dirMain = gitAt(repo, 'rev-parse', '--path-format=absolute', '--git-dir');
  const dirBranch = gitAt(branch, 'rev-parse', '--path-format=absolute', '--git-dir');
  assert.equal(commonMain, commonBranch, 'the real linked worktree shares the main Git common directory');
  assert.notEqual(dirMain, dirBranch, 'the source roots have distinct Git directories');

  const afterJoin = footprint();
  assert.deepEqual({ schemaVersion: afterJoin.schemaVersion, schemaCookie: afterJoin.schemaCookie, itemColumns: afterJoin.itemColumns, schemaObjects: afterJoin.schemaObjects, triggers: afterJoin.triggers },
    { schemaVersion: before.schemaVersion, schemaCookie: before.schemaCookie, itemColumns: before.itemColumns, schemaObjects: before.schemaObjects, triggers: before.triggers },
    'fixture setup and branch source commit did not alter the native board DDL');

  const read = cli(branch, 'status');
  assert.equal(read.status, 0, read.stderr + read.stdout);
  const readDocument = JSON.parse(read.stdout);
  assert.equal(readDocument.version, 1);
  const afterRead = footprint();
  assert.deepEqual({ schemaVersion: afterRead.schemaVersion, schemaCookie: afterRead.schemaCookie, itemColumns: afterRead.itemColumns, schemaObjects: afterRead.schemaObjects, triggers: afterRead.triggers },
    { schemaVersion: before.schemaVersion, schemaCookie: before.schemaCookie, itemColumns: before.itemColumns, schemaObjects: before.schemaObjects, triggers: before.triggers },
    'branch read did not install its migration column or trigger SQL');
  assert.equal(afterRead.eventCount, before.eventCount, 'a read changes no shared board events');

  const move = cli(branch, 'claim', String(itemId));
  assert.equal(move.status, 0, move.stderr + move.stdout);
  assert.equal(JSON.parse(move.stdout).id, itemId, 'the ordinary branch move returns its shared item');
  const afterMove = footprint();
  assert.deepEqual({ schemaVersion: afterMove.schemaVersion, schemaCookie: afterMove.schemaCookie, itemColumns: afterMove.itemColumns, schemaObjects: afterMove.schemaObjects, triggers: afterMove.triggers },
    { schemaVersion: before.schemaVersion, schemaCookie: before.schemaCookie, itemColumns: before.itemColumns, schemaObjects: before.schemaObjects, triggers: before.triggers },
    'normal move preserved main schema and machine triggers');
  assert.equal(afterMove.eventCount, before.eventCount + 1, 'the ordinary claim has a normal shared-board event effect');
  assert.equal(afterMove.item.item_status, 'claimed');
  assert.equal(afterMove.item.item_owner, joinedDocument.agent);

  for (const result of [read, move]) {
    const output = [result.stdout, result.stderr].join('\n');
    assert.equal(output.match(/item_branch_probe/gu)?.length ?? 0, 1,
      `one diagnostic per invocation names the uninstalled column exactly once:\n${output}`);
    assert.equal(output.match(/machine_item_move/gu)?.length ?? 0, 1,
      `the same diagnostic names the changed machine trigger exactly once:\n${output}`);
  }
  return { read: [read.stdout, read.stderr].join('\n'), claim: [move.stdout, move.stderr].join('\n') };
}
