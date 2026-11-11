/** Machine-storage and board permission refusals name the blocked folder and the step that grants it [I1,C7,Q4]. */
import assert from 'node:assert/strict';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderAgentsBlock } from '../../config/index.js';
import {
  closeResourceConnections,
  listResources,
} from '../../resources/index.js';
import { registerProject } from '../../seats/index.js';
import {
  DEFAULT_NEXT_STEPS,
  RECORDED_GENERIC_NEXT,
  recordedRefusal,
} from '../../state/index.js';
import {
  boardNotWritable,
  requireBoardWriteAccess,
} from '../../store/index.js';
import { cellBoard } from '../../store/tests/fixtures/cell.js';
import { cellProject } from '../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../store/tests/fixtures/cell.js';

/** Run work with the machine home pointed at a directory, then restore the environment and release the pool. */
async function withMachineHome(home, work) {
  const saved = { machine: process.env.PULLBOARD_MACHINE_HOME, board: process.env.PULLBOARD_HOME };
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { return await work(); } finally {
    closeResourceConnections();
    for (const [key, value] of [['PULLBOARD_MACHINE_HOME', saved.machine], ['PULLBOARD_HOME', saved.board]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

/** Check the named refusal, its actual blocked directory and both usable next steps. */
function refused(work, directory) {
  assert.throws(work, error => {
    const output = `${error.code} ${error.message}`;
    assert.equal(error.code, 'MACHINE_HOME_NOT_WRITABLE', output);
    assert.ok(output.includes(directory), output);
    assert.match(output, /write access to that directory/u);
    assert.match(output, /run the command outside the sandbox/u);
    assert.doesNotMatch(output, /unable to open database file/iu);
    return true;
  });
}

test('an unwritable machine home is refused by name [I1,C7,Q4]', async (t) => {
  await t.test('a registry refresh names a blocked project registry', async () => {
    const p = cellProject(t, { gate: 'true' });
    const home = join(p.dir, 'machine-home');
    mkdirSync(home, { recursive: true });
    process.env.PULLBOARD_HOME = home;
    await withMachineHome(home, () => {
      registerProject(p.repo);
      // A real metadata refresh must create its SQLite lock in the now-blocked directory.
      rmSync(join(home, 'projects.json.lock.sqlite'));
      chmodSync(home, 0o500);
      try {
        assert.throws(() => writeFileSync(join(home, 'permission-sentinel'), ''), { code: 'EACCES' });
        refused(() => registerProject(p.repo), home);
      } finally { chmodSync(home, 0o700); }
    });
  });
  await t.test('the pool override is independent of the writable project registry', async () => {
    const p = cellProject(t, { gate: 'true' });
    const home = join(p.dir, 'pool-home');
    mkdirSync(home, { recursive: true });
    process.env.PULLBOARD_HOME = join(p.dir, 'board-home');
    await withMachineHome(home, () => {
      assert.notEqual(home, process.env.PULLBOARD_HOME);
      rmSync(join(home, 'resources.sqlite'), { force: true });
      chmodSync(home, 0o500);
      try {
        refused(() => listResources({ scope: 'machine', root: p.repo }), home);
        assert.equal(existsSync(join(home, 'resources.sqlite')), false);
      } finally { chmodSync(home, 0o700); }
      assert.doesNotThrow(() => listResources({ scope: 'machine', root: p.repo }), 'restoring write access restores the real pool');
    });
  });
  await t.test('a blocked parent names the requested missing machine home', async () => {
    const p = cellProject(t, { gate: 'true' });
    const parent = join(p.dir, 'blocked-parent');
    mkdirSync(parent);
    const home = join(parent, 'new-machine-home');
    process.env.PULLBOARD_HOME = join(p.dir, 'board-home');
    await withMachineHome(home, () => {
      chmodSync(parent, 0o500);
      try {
        refused(() => listResources({ scope: 'machine', root: p.repo }), home);
        assert.equal(existsSync(home), false);
      } finally { chmodSync(parent, 0o700); }
    });
  });
});

/** Make the shared board folder, its files and its subfolders (such as trace) read-only, as a read-only sandbox sees it. */
function lockBoard(folder) {
  for (const name of readdirSync(folder)) chmodSync(join(folder, name), statSync(join(folder, name)).isDirectory() ? 0o555 : 0o444);
  chmodSync(folder, 0o555);
}

/** Give the board folder, its files and its subfolders write access again; a subfolder left without search access cannot be cleaned up. */
function unlockBoard(folder) {
  chmodSync(folder, 0o755);
  for (const name of readdirSync(folder)) chmodSync(join(folder, name), statSync(join(folder, name)).isDirectory() ? 0o755 : 0o644);
}

/** A project whose real board has been created and closed, so its folder holds a board file to lock. */
function boardProject(t) {
  const p = cellProject(t, { gate: 'true' });
  cellBoard(t, p.boardFile, undefined, { gitRoot: p.repo }).db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { ...p, folder: join(p.repo, '.git', 'pullboard') };
}

test('a read-only board refuses the write check by name [I1,L3,P4]', (t) => {
  const p = boardProject(t);
  assert.doesNotThrow(() => requireBoardWriteAccess(p.boardFile), 'the board is writable before it is locked');
  lockBoard(p.folder);
  try {
    assert.throws(() => writeFileSync(join(p.folder, 'permission-sentinel'), ''), { code: 'EACCES' });
    assert.throws(() => requireBoardWriteAccess(p.boardFile), error => {
      const output = `${error.code} ${error.message}`;
      assert.equal(error.code, 'BOARD_NOT_WRITABLE', 'the refusal is named');
      assert.ok(output.includes(p.folder), `the refusal names the board folder: ${output}`);
      assert.doesNotMatch(output, /readonly database|at Module\.|ERR_SQLITE_ERROR/iu, 'no raw database trace');
      const next = DEFAULT_NEXT_STEPS.BOARD_NOT_WRITABLE;
      assert.match(next, /write access to .*\.git\/pullboard.*outside the sandbox/u, 'the step names the folder and the way out');
      assert.doesNotMatch(next, /service owner/u, 'the step is not the unknown-code footer');
      assert.notEqual(next, RECORDED_GENERIC_NEXT, 'the step is not the generic footer');
      assert.match(recordedRefusal(error).next, /write access to .*\.git\/pullboard.*outside the sandbox/u, 'a recorded refusal carries the same step');
      return true;
    });
  } finally { unlockBoard(p.folder); }
  assert.doesNotThrow(() => requireBoardWriteAccess(p.boardFile), 'restoring write access, the step it names, lets the check pass');
});

test('a Codex agent that cannot write the board is told the Codex step that grants it [I1,P4]', (t) => {
  const p = boardProject(t);
  // init's agent guidance names the step before the first refusal.
  const guidance = renderAgentsBlock('doctrine', 'doctrine text');
  assert.match(guidance, /\*\*Codex\.\*\* .*codex --add-dir "\$\(git rev-parse --path-format=absolute --git-common-dir\)\/pullboard"/u);
  // A named permission profile ignores writable_roots, so the guidance gives each settings form its own step (#913).
  assert.match(guidance, /a permission profile takes `"<that folder>" = "write"` in its `\[permissions\.<profile>\.filesystem\]` table; only settings without a profile use `writable_roots`/u);
  lockBoard(p.folder);
  try {
    const denied = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const error = boardNotWritable(p.boardFile, denied, { CODEX_THREAD_ID: 'codex-thread-913' });
    assert.equal(error.code, 'BOARD_NOT_WRITABLE');
    assert.match(error.message, /Codex's workspace-write sandbox keeps \.git read-only/u);
    assert.equal(error.next, `restart Codex with that folder writable: codex --add-dir '${p.folder}'; to keep it in ~/.codex/config.toml, a permission profile takes ${JSON.stringify(p.folder)} = "write" in its [permissions.<active-profile>.filesystem] table, and only settings without a profile use writable_roots under [sandbox_workspace_write]; then run the command again`);
  } finally { unlockBoard(p.folder); }
});

test('the write check covers both board-file and journal-folder capability without leaving a probe [I1,L3,P4]', (t) => {
  for (const blocked of ['file', 'folder']) {
    const p = boardProject(t);
    const { folder, boardFile: file } = p;
    assert.doesNotThrow(() => requireBoardWriteAccess(file), 'the check passes before access is removed');
    const before = readFileSync(file);
    chmodSync(blocked === 'file' ? file : folder, blocked === 'file' ? 0o444 : 0o555);
    try {
      if (blocked === 'file') assert.throws(() => appendFileSync(file, ''), { code: 'EACCES' });
      else assert.throws(() => writeFileSync(join(folder, 'permission-sentinel'), ''), { code: 'EACCES' });
      assert.throws(() => requireBoardWriteAccess(file), { code: 'BOARD_NOT_WRITABLE' }, `${blocked} permission has its own real refusal`);
      assert.equal(readFileSync(file).equals(before), true, 'the readiness check changes no board bytes');
    } finally { chmodSync(blocked === 'file' ? file : folder, blocked === 'file' ? 0o644 : 0o755); }
    assert.doesNotThrow(() => requireBoardWriteAccess(file), 'the named permission repair restores readiness');
    assert.deepEqual(readdirSync(folder).filter(name => name.startsWith('.write-access-')), [], 'successful and refused checks leave no probe');
  }
});

/**
 * The three contexts a command opens the shared board from. The installed CLI runs from outside any worktree and the main
 * checkout from the main one, so both open the board directly; a lane worktree is told it is not main and first probes
 * the board read-only. Each hint is the one the command derives from where it runs, so both paths meet the locked folder.
 */
const OPEN_CONTEXTS = [['installed pullboard', undefined], ['main checkout', true], ['lane worktree', false]];

test('a read-only board is refused by name in the installed, main-checkout and lane-worktree contexts [I1,L3,P4]', (t) => {
  const p = cellProject(t, { gate: 'true' });
  // A board folder that is not a repository's own, so the context hint alone decides how the board is opened.
  const folder = join(p.dir, 'pullboard');
  const file = join(folder, 'board.sqlite');
  mkdirSync(folder);
  const created = openCellBoard(file, undefined, { isMain: true });
  created.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  closeCellBoard(created);
  for (const [label, isMain] of OPEN_CONTEXTS) {
    assert.doesNotThrow(() => closeCellBoard(openCellBoard(file, undefined, { isMain })), `${label} opens the board before it is locked`);
  }
  lockBoard(folder);
  try {
    assert.throws(() => writeFileSync(join(folder, 'permission-sentinel'), ''), { code: 'EACCES' });
    for (const [label, isMain] of OPEN_CONTEXTS) {
      assert.throws(() => closeCellBoard(openCellBoard(file, undefined, { isMain })), error => {
        const output = `${error.code} ${error.message}`;
        assert.equal(error.code, 'BOARD_NOT_WRITABLE', `${label} names the refusal: ${output}`);
        assert.ok(output.includes(folder), `${label} names the board folder: ${output}`);
        assert.doesNotMatch(output, /readonly database|at Module\.|ERR_SQLITE_ERROR/iu, `${label} prints no raw database trace`);
        // The versioned result carries the code and the step, as `resume --json` printed them.
        const recorded = recordedRefusal(error);
        assert.equal(recorded.code, 'BOARD_NOT_WRITABLE', `${label} --json carries the code`);
        assert.match(recorded.next, /write access to .*\.git\/pullboard.*outside the sandbox/u, `${label} --json next names the step`);
        assert.doesNotMatch(recorded.next, /service owner/u, `${label} --json next is not the unknown-code footer`);
        assert.notEqual(recorded.next, RECORDED_GENERIC_NEXT, `${label} --json next is not the generic footer`);
        return true;
      });
    }
  } finally { unlockBoard(folder); }
  for (const [label, isMain] of OPEN_CONTEXTS) {
    assert.doesNotThrow(() => closeCellBoard(openCellBoard(file, undefined, { isMain })), `${label}: restoring write access, the step it names, lets the board open`);
  }
});
