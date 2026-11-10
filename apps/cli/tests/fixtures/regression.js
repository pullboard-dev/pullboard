/** Exercise the public no-options board opener from branch code on shared and private files [A5,A6,C7]. */
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
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

/** Run an isolated fixture command and retain its output for precise assertions. */
function run(command, args, cwd, env) {
  return spawnSync(command, args, { cwd, env, encoding: 'utf8' });
}

/**
 * Prove direct openBoard calls distinguish the repository-shared file from a private database.
 * The branch source adds same-version DDL and changes one machine trigger before opening either.
 *
 * @param {{ after: (cleanup: () => void) => void }} t
 * @param {string} sourceRoot
 */
export function assertDirectOpenBoardIsolation(t, sourceRoot) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-direct-open-board-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const main = join(directory, 'repo');
  const branch = join(directory, 'branch');
  mkdirSync(main);
  copyPackageFiles(sourceRoot, main);
  writeFileSync(join(main, 'pullboard.json'), `${JSON.stringify({
    gate: 'true',
    spec: 'SPEC.md',
    lanes: { web: { owns: ['web/'], specs: [] } },
    shared: [],
  }, null, 2)}\n`);
  writeFileSync(join(main, 'SPEC.md'), '# Direct opener fixture\n\n## G · Goals\n- G1 [approved, must] Keep shared DDL stable. | gate: true\n');
  const env = {
    ...process.env,
    HOME: join(directory, 'home'),
    PULLBOARD_HOME: join(directory, 'pullboard-home'),
    PULLBOARD_MACHINE_HOME: join(directory, 'machine-home'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Direct Opener Fixture',
    GIT_AUTHOR_EMAIL: 'direct-opener@example.test',
    GIT_COMMITTER_NAME: 'Direct Opener Fixture',
    GIT_COMMITTER_EMAIL: 'direct-opener@example.test',
  };
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_') && !name.startsWith('GIT_CONFIG_')
        && !name.startsWith('GIT_AUTHOR_') && !name.startsWith('GIT_COMMITTER_')) delete env[name];
  }
  /** Require each real private Git operation to succeed. */
  const git = (cwd, ...args) => {
    const result = run('git', args, cwd, env);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout.trim();
  };
  /** Run each checkout source independently under the private environment. */
  const cli = (cwd, ...args) => run(process.execPath, [join(cwd, 'apps/cli/pullboard.js'), ...args, '--json'], cwd, env);

  git(main, 'init', '-q', '-b', 'main');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'chore: initialize direct opener fixture');
  const initialized = cli(main, 'status');
  assert.equal(initialized.status, 0, initialized.stderr + initialized.stdout);
  const linked = run('git', ['worktree', 'add', '-q', '-b', 'schema/drift', branch, 'main'], main, env);
  assert.equal(linked.status, 0, linked.stderr + linked.stdout);

  const joined = cli(branch, 'join', 'web', '--model', 'fixture-worker', '--route', 'strong');
  assert.equal(joined.status, 0, joined.stderr + joined.stdout);
  const { agent } = JSON.parse(joined.stdout);
  const added = cli(main, 'add', 'web', 'direct opener shared move', '--criterion', 'the direct branch opener uses the native board');
  assert.equal(added.status, 0, added.stderr + added.stdout);
  const itemId = JSON.parse(added.stdout).item.item_id;
  const sharedFile = join(main, '.git', 'pullboard', 'board.sqlite');
  const privateFile = join(directory, 'private.sqlite');

  const boardSourcePath = join(branch, 'packages/store/src/io/board/migrate.js');
  const originalBoardSource = readFileSync(boardSourcePath, 'utf8');
  const migration = "  ['item', 'item_after', \"TEXT NOT NULL DEFAULT ''\"],";
  assert.ok(originalBoardSource.includes(migration), 'candidate source contains the stable migration insertion point');
  const driftedBoardSource = originalBoardSource.replace(migration,
    `${migration}\n  ['item', 'item_branch_probe', \"TEXT NOT NULL DEFAULT ''\"],`);
  assert.notEqual(driftedBoardSource, originalBoardSource);
  writeFileSync(boardSourcePath, driftedBoardSource);
  const machineSourcePath = join(branch, 'packages/state/src/io/machine.js');
  const originalMachineSource = readFileSync(machineSourcePath, 'utf8');
  const triggerBody = "refuse('UNDECLARED_MOVE', `the moves are ${moves.join(', ')}`)";
  const branchTriggerBody = "refuse('UNDECLARED_MOVE', `branch fixture moves are ${moves.join(', ')}`)";
  assert.ok(originalMachineSource.includes(triggerBody), 'candidate trigger source contains the expected clause');
  writeFileSync(machineSourcePath, originalMachineSource.replace(triggerBody, branchTriggerBody));
  git(branch, 'add', 'packages/store/src/io/board/migrate.js', 'packages/state/src/io/machine.js');
  git(branch, 'commit', '-q', '-m', 'feat: simulate branch-local schema declarations');

  /** Observe shared DDL and effect evidence without invoking an opener. */
  const footprint = (file, id = null) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return {
        version: db.prepare('PRAGMA user_version').get().user_version,
        schemaCookie: db.prepare('PRAGMA schema_version').get().schema_version,
        columns: db.prepare('PRAGMA table_info(item)').all().map(row => row.name),
        triggers: db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'machine%' ORDER BY name").all(),
        ...(id === null ? {} : { item: db.prepare('SELECT item_id, item_status, item_owner FROM item WHERE item_id=?').get(id) }),
        events: db.prepare('SELECT count(*) AS n FROM event').get().n,
      };
    } finally { db.close(); }
  };
  const sharedBefore = footprint(sharedFile, itemId);

  // Create a separate normal board from main code. The branch's new migration and trigger must
  // still install here; only the repository-shared path is protected from unmerged declarations.
  const createPrivate = run(process.execPath, ['--input-type=module', '-e', `
    import { closeBoard } from './packages/store/index.js';
    import { openBoard } from './apps/lib/index.js';
    const board = openBoard(${JSON.stringify(privateFile)});
    closeBoard(board);
  `], main, env);
  assert.equal(createPrivate.status, 0, createPrivate.stderr + createPrivate.stdout);
  const privateBefore = footprint(privateFile);
  assert.ok(!privateBefore.columns.includes('item_branch_probe'));
  assert.ok(!privateBefore.triggers.find(row => row.name === 'machine_item_move').sql.includes('branch fixture moves'));

  // This is deliberately a direct API caller: no options object and no CLI wrapper supplying
  // isMain. It reads and performs an ordinary claim using the existing main-board schema.
  const directProbe = run(process.execPath, ['--input-type=module', '-e', `
    import { closeBoard, getItem, claim } from './packages/store/index.js';
    import { openBoard } from './apps/lib/index.js';
    const board = openBoard(${JSON.stringify(sharedFile)});
    try {
      const before = getItem(board, ${itemId});
      const result = claim(board, ${itemId}, {
        agentId: ${JSON.stringify(agent)}, lane: 'web', leaseMs: 3600000,
        freeze: item => ({ text: item.item_title, digest: 'fixture:' + item.item_title }),
      });
      const after = getItem(board, ${itemId});
      console.log(JSON.stringify({ before: before.item_status, result, after: after.item_status, owner: after.item_owner }));
    } finally { closeBoard(board); }
  `], branch, env);
  assert.equal(directProbe.status, 0, directProbe.stderr + directProbe.stdout);
  const directResult = JSON.parse(directProbe.stdout);
  assert.equal(directResult.before, 'open');
  assert.equal(directResult.after, 'claimed');
  assert.equal(directResult.owner, agent);
  assert.match(directProbe.stderr, /item_branch_probe/u);
  assert.match(directProbe.stderr, /machine_item_move/u);
  assert.equal(directProbe.stderr.match(/item_branch_probe/gu)?.length ?? 0, 1,
    'one direct open emits one diagnostic naming the uninstalled migration column');
  assert.equal(directProbe.stderr.match(/machine_item_move/gu)?.length ?? 0, 1,
    'one direct open emits one diagnostic naming the changed trigger');

  const sharedAfter = footprint(sharedFile, itemId);
  assert.equal(sharedAfter.version, sharedBefore.version);
  assert.equal(sharedAfter.schemaCookie, sharedBefore.schemaCookie,
    'the direct branch read-and-move made no shared schema changes');
  assert.deepEqual(sharedAfter.columns, sharedBefore.columns);
  assert.deepEqual(sharedAfter.triggers, sharedBefore.triggers);
  assert.equal(sharedAfter.events, sharedBefore.events + 1, 'the normal claim still has its shared-board effect');

  // A private database migrates only when its user_version is behind (#1047), as an older board's is.
  const lowered = new DatabaseSync(privateFile);
  try { lowered.exec('PRAGMA user_version = 1'); } finally { lowered.close(); }
  const privateProbe = run(process.execPath, ['--input-type=module', '-e', `
    import { closeBoard } from './packages/store/index.js';
    import { openBoard } from './apps/lib/index.js';
    const board = openBoard(${JSON.stringify(privateFile)});
    closeBoard(board);
  `], branch, env);
  assert.equal(privateProbe.status, 0, privateProbe.stderr + privateProbe.stdout);
  const privateAfter = footprint(privateFile);
  assert.ok(privateAfter.columns.includes('item_branch_probe'),
    'a private database still receives the branch migration');
  assert.ok(privateAfter.triggers.find(row => row.name === 'machine_item_move').sql.includes('branch fixture moves'),
    'a private database still receives the branch machine trigger declaration');
  assert.equal(privateAfter.version, privateBefore.version, 'an older private database migrates back to the current version');
}
