/** @pullboard-test-loads src/cli/view-state.js */
/** View projection refuses migrations from linked source and borrows staged boards without owning them [A5,A6,A2]. */
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  addItem,
  closeBoard,
} from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { beginCommandPhase } from '../../../../packages/link/index.js';
import { disableFixtureBackgroundView } from '../../tests/fixtures/cockpit/view.js';

/** Copy the actual candidate into a private primary repo and linked source checkout. */
function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-view-provenance-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const lane = join(dir, 'lane');
  const source = resolve(import.meta.dirname, '../../../..');
  const executables = join(dir, 'executables');
  mkdirSync(executables);
  writeFileSync(join(executables, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "$(git rev-parse --show-toplevel)/apps/cli/pullboard.js" "$@"\n`);
  chmodSync(join(executables, 'pullboard'), 0o755);
  mkdirSync(root);
  copyPackageFiles(source, root);
  const env = {
    ...process.env,
    HOME: join(dir, 'home'),
    PULLBOARD_HOME: join(dir, 'board-home'),
    PULLBOARD_MACHINE_HOME: join(dir, 'machine-home'),
    PATH: `${executables}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'View Provenance Test',
    GIT_AUTHOR_EMAIL: 'provenance@example.test',
    GIT_COMMITTER_NAME: 'View Provenance Test',
    GIT_COMMITTER_EMAIL: 'provenance@example.test',
  };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) {
    if (!['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(key)) delete env[key];
  }
  delete env.PULLBOARD_RELAY_TOKEN;
  /** Run a process inside the private fixture environment. */
  const run = (cwd, command, args) => spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  /** Require a real Git command to complete normally, with hooks enabled. */
  const git = (cwd, ...args) => {
    const result = run(cwd, 'git', args);
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}${result.stdout}`);
    return result.stdout.trim();
  };
  /** Execute the selected checkout's actual CLI code, independently of the command's cwd. */
  const cli = (codeRoot, cwd, ...args) => run(cwd, process.execPath, [join(codeRoot, 'apps/cli/pullboard.js'), ...args]);
  /** Read only the persistent schema and event-log version markers. */
  const versions = () => {
    const db = new DatabaseSync(join(root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
    try {
      return {
        schema: db.prepare('PRAGMA user_version').get().user_version,
        eventLog: db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='event_log_version'").get().meta_value,
      };
    } finally { db.close(); }
  };
  /** Export every persistent board table through a read-only SQLite connection. */
  const snapshot = () => {
    const db = new DatabaseSync(join(root, '.git', 'pullboard', 'board.sqlite'), { readOnly: true });
    try { return exportBoard({ db }, { beginCommandPhase }); }
    finally { db.close(); }
  };
  /** Change exactly one version constant in linked source, leaving the primary source untouched. */
  const bump = (name, from, to) => {
    // The schema constants moved behind the store package shim (3d2332018b).
    const path = join(lane, 'packages/store/src/io/board/schema/source.js');
    const before = readFileSync(path, 'utf8');
    const after = before.replace(`export const ${name} = ${from};`, `export const ${name} = ${to};`);
    assert.notEqual(after, before, `the linked checkout contains ${name} ${from}`);
    writeFileSync(path, after);
  };
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true', lanes: { core: { owns: ['src/'] } } }));
  writeFileSync(join(root, 'SPEC.md'), '# View provenance fixture\n\n## G · Goals\n- G1 [approved, must] Keep the primary board unchanged. | gate: true\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: initialize provenance fixture');
  // This custom fixture initializes directly rather than through fixture.js project().
  disableFixtureBackgroundView(env, dir);
  assert.equal(JSON.parse(readFileSync(join(env.PULLBOARD_MACHINE_HOME, 'settings.json'), 'utf8')).view.background, false,
    'the copied CLI sees the private opt-out before initialization');
  const initialized = cli(root, root, 'init');
  assert.equal(initialized.status, 0, `${initialized.stderr}${initialized.stdout}`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'chore: install provenance fixture hooks');
  git(root, 'worktree', 'add', '-q', '-b', 'core/future', lane, 'main');
  const joined = cli(root, lane, 'join', 'core', '--json');
  assert.equal(joined.status, 0, `${joined.stderr}${joined.stdout}`);
  return { dir, root, lane, run, git, cli, versions, snapshot, bump };
}

/** Ask actual linked serve.js to project the primary root while falsely supplying isMain=true. */
async function linkedProjectState(box, options = {}) {
  const source = await import(pathToFileURL(join(box.lane, 'apps', 'cli', 'src', 'io', 'view.js')).href);
  return source.projectState(box.root, { isMain: true, ...options });
}

/** Prove the failed open changed neither the complete SQLite file nor any exported rows/version. */
function assertSharedBoardUnchanged(box, before) {
  assert.equal(box.versions().schema, before.versions.schema);
  assert.equal(box.versions().eventLog, before.versions.eventLog);
  assert.deepEqual(box.snapshot(), before.snapshot, 'all exported shared-board rows remain unchanged');
  assert.equal(createHash('sha256').update(readFileSync(before.file)).digest('hex'), before.fileSha256,
    'the shared SQLite file bytes remain unchanged');
}

/** Capture immutable shared-board facts after all setup connections have closed. */
function captureSharedBoard(box) {
  const file = join(box.root, '.git', 'pullboard', 'board.sqlite');
  return {
    file,
    fileSha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
    versions: box.versions(),
    snapshot: box.snapshot(),
  };
}

/** Require a refusal, unchanged shared data, and a successful subsequent open by the primary source. */
async function assertLinkedRefusalAndPrimaryRecovery(box) {
  const before = captureSharedBoard(box);
  await assert.rejects(linkedProjectState(box), error => error.code === 'UNMERGED_SCHEMA',
    'linked view source refuses the newer format even when the caller says isMain=true');
  assertSharedBoardUnchanged(box, before);
  const primary = box.cli(box.root, box.root, 'status', '--json');
  assert.equal(primary.status, 0, `${primary.stderr}${primary.stdout}`);
  const primaryView = await import(pathToFileURL(join(box.root, 'apps', 'cli', 'src', 'io', 'view.js')).href);
  assert.equal(primaryView.projectState(box.root).root, box.root, 'primary view source still opens the same board');
  assertSharedBoardUnchanged(box, before);
}

test('clause 1: linked view source refuses a schema-only upgrade of the primary board [A5,A6,A2]', async t => {
  const box = fixture(t);
  box.bump('SCHEMA_VERSION', 3, 4);
  await assertLinkedRefusalAndPrimaryRecovery(box);
});

test('clause 1: linked view source refuses an event-log-only upgrade of the primary board [A5,A6,A2]', async t => {
  const box = fixture(t);
  box.bump('EVENT_LOG_VERSION', 1, 2);
  await assertLinkedRefusalAndPrimaryRecovery(box);
});

test('clause 1: linked projection can read a borrowed staged board without closing it or changing the primary [A5,A6,A2]', async t => {
  const box = fixture(t);
  box.bump('EVENT_LOG_VERSION', 1, 2);
  const before = captureSharedBoard(box);
  const staged = openBoard(':memory:', undefined, { isMain: true });
  try {
    importBoard(staged, before.snapshot);
    const stagedId = addItem(staged, { by: 'coordinator', lane: 'core', title: 'Only in staged recovery', criterion: 'projected without a native board open' });
    const stagedBefore = exportBoard(staged);
    let projected;
    await assert.doesNotReject(async () => { projected = await linkedProjectState(box, { board: staged }); },
      'newer linked source borrows staged data without attempting a native board migration');
    assert.equal(projected.root, box.root, 'the linked projector reads the primary project configuration');
    assert.ok(projected.items.some(item => item.id === stagedId && item.title === 'Only in staged recovery'),
      'projection reads the actual caller-owned staged item');
    assert.doesNotThrow(() => assert.equal(staged.db.prepare('SELECT 1 AS open').get().open, 1),
      'the caller-owned connection remains open');
    assert.deepEqual(exportBoard(staged), stagedBefore, 'projection leaves every staged row unchanged');
    assertSharedBoardUnchanged(box, before);
  } finally { closeBoard(staged); }
});
