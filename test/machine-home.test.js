/** @pullboard-test-input source-tree */
/** Real machine-storage permission refusals preserve the shared queue location [I1,C7,Q4]. */
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { runFixtureChild } from './fixture-child.js';
import { RECORDED_GENERIC_NEXT } from '../src/recorded-refusal.js';

const { sandbox, project, cleanup } = createE2eHelpers();
after(cleanup);

/** Check the named refusal, its actual blocked directory and both usable next steps. */
function refused(result, directory) {
  const output = result.out + result.err;
  assert.notEqual(result.code, 0, output);
  assert.match(output, /MACHINE_HOME_NOT_WRITABLE/u);
  assert.ok(output.includes(directory), output);
  assert.match(output, /write access to that directory/u);
  assert.match(output, /run the command outside the sandbox/u);
  assert.doesNotMatch(output, /unable to open database file/iu);
}

test('an unwritable machine home is refused by name [I1,C7,Q4]', async (t) => {
  await t.test('resume names a blocked project registry when refreshing its metadata', () => {
    const box = sandbox();
    box.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_HOME;
    const p = project(undefined, box);
    const home = p.env.PULLBOARD_MACHINE_HOME;
    const folder = join(home, 'relay-machine');
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, 'state.json'), JSON.stringify({ v: 2, autoLink: true,
      owner: null, machine: 'machine-fixture', devices: [], excluded: [], pending: null,
      revocations: [], approvals: [] }), { mode: 0o600 });
    const config = join(p.repo, 'pullboard.json');
    writeFileSync(config, JSON.stringify({ ...JSON.parse(readFileSync(config, 'utf8')), name: 'Renamed project' }));
    // A real metadata refresh must create its SQLite lock in the now-blocked directory.
    rmSync(join(home, 'projects.json.lock.sqlite'));
    chmodSync(home, 0o500);
    try {
      assert.throws(() => writeFileSync(join(home, 'permission-sentinel'), ''), { code: 'EACCES' });
      refused(p.run(p.repo, 'resume'), home);
    } finally { chmodSync(home, 0o700); }
  });
  await t.test('the pool override is independent of the writable project registry', () => {
    const p = project();
    const home = p.env.PULLBOARD_MACHINE_HOME;
    assert.notEqual(home, p.env.PULLBOARD_HOME);
    mkdirSync(home, { recursive: true });
    rmSync(join(home, 'resources.sqlite'), { force: true });
    chmodSync(home, 0o500);
    try {
      refused(p.run(p.repo, 'resources'), home);
      assert.equal(existsSync(join(home, 'resources.sqlite')), false);
    } finally { chmodSync(home, 0o700); }
    assert.equal(p.run(p.repo, 'resources').code, 0, 'restoring write access restores the real pool');
  });
  await t.test('a blocked parent names the requested missing machine home', () => {
    const p = project();
    const parent = join(p.dir, 'blocked-parent');
    mkdirSync(parent);
    p.env.PULLBOARD_MACHINE_HOME = join(parent, 'new-machine-home');
    chmodSync(parent, 0o500);
    try {
      refused(p.run(p.repo, 'resources'), p.env.PULLBOARD_MACHINE_HOME);
      assert.equal(existsSync(p.env.PULLBOARD_MACHINE_HOME), false);
    } finally { chmodSync(parent, 0o700); }
  });
});

/** Make the shared board folder and every file in it read-only, as a read-only sandbox sees it. */
function lockBoard(folder) {
  for (const name of readdirSync(folder)) chmodSync(join(folder, name), 0o444);
  chmodSync(folder, 0o555);
}

/** Give the board folder and its files write access again. */
function unlockBoard(folder) {
  chmodSync(folder, 0o755);
  for (const name of readdirSync(folder)) chmodSync(join(folder, name), 0o644);
}

/**
 * Copy this checkout's CLI outside any Git repo, as npm installs it, and return a runner for it.
 * Code outside a worktree opens the board directly; code in a worktree first probes it read-only,
 * so both paths to the board meet the read-only folder.
 */
function installedCli(p) {
  const cli = join(p.dir, 'installed-pullboard');
  for (const part of ['src', 'bin', 'skills', 'package.json', 'CHANGELOG.md']) cpSync(join(import.meta.dirname, '..', part), join(cli, part), { recursive: true });
  return (cwd, ...args) => {
    const result = runFixtureChild(process.execPath, [join(cli, 'bin', 'pullboard.js'), ...args], { cwd, env: p.env, encoding: 'utf8' });
    return { code: result.status, out: result.stdout, err: result.failure ?? result.stderr };
  };
}

test('a read-only board refuses resume by name [I1,L3,P4]', () => {
  const p = project();
  const installed = installedCli(p);
  const folder = join(p.repo, '.git', 'pullboard');
  assert.equal(installed(p.repo, 'resume').code, 0, 'the installed CLI opens the board before it is locked');
  lockBoard(folder);
  try {
    assert.throws(() => writeFileSync(join(folder, 'permission-sentinel'), ''), { code: 'EACCES' });
    const runs = [['installed pullboard', installed, p.repo], ['main checkout', p.run, p.repo], ['lane worktree', p.run, p.web]];
    for (const [label, run, cwd] of runs) {
      const text = run(cwd, 'resume');
      const output = text.out + text.err;
      assert.notEqual(text.code, 0, `${label}: ${output}`);
      assert.match(output, /BOARD_NOT_WRITABLE/u, `${label} names the refusal`);
      assert.ok(output.includes(folder), `${label} names the board folder: ${output}`);
      assert.doesNotMatch(output, /readonly database|at Module\.|ERR_SQLITE_ERROR/iu, `${label} prints no raw database trace`);
      const json = run(cwd, 'resume', '--json');
      assert.notEqual(json.code, 0, `${label} --json: ${json.out}${json.err}`);
      const { error } = JSON.parse(json.out);
      assert.equal(error.code, 'BOARD_NOT_WRITABLE', `${label} --json carries the code`);
      assert.match(error.next, /write access to .*\.git\/pullboard.*outside the sandbox/u, `${label} --json next names the step`);
      assert.doesNotMatch(error.next, /service owner/u, `${label} --json next is not the unknown-code footer`);
      assert.notEqual(error.next, RECORDED_GENERIC_NEXT, `${label} --json next is not the generic footer`);
    }
  } finally { unlockBoard(folder); }
  assert.equal(p.run(p.repo, 'resume').code, 0, 'restoring write access, the step it names, lets resume run');
});

test('a Codex agent that cannot write the board is told the Codex step that grants it [I1,P4]', () => {
  const p = project();
  const folder = join(p.repo, '.git', 'pullboard');
  assert.equal(p.run(p.repo, 'resume').code, 0, 'the board opens before it is locked');
  // init's agent guidance names the step before the first refusal.
  assert.match(readFileSync(join(p.repo, 'AGENTS.md'), 'utf8'), /\*\*Codex\.\*\* .*codex --add-dir "\$\(git rev-parse --path-format=absolute --git-common-dir\)\/pullboard"/u);
  // A named permission profile ignores writable_roots, so the guidance gives each settings form its own step (#913).
  assert.match(readFileSync(join(p.repo, 'AGENTS.md'), 'utf8'), /a permission profile takes `"<that folder>" = "write"` in its `\[permissions\.<profile>\.filesystem\]` table; only settings without a profile use `writable_roots`/u);
  lockBoard(folder);
  try {
    const codex = runFixtureChild(process.execPath, [join(import.meta.dirname, '..', 'bin', 'pullboard.js'), 'resume', '--json'],
      { cwd: p.repo, env: { ...p.env, CODEX_THREAD_ID: 'codex-thread-913' }, encoding: 'utf8' });
    assert.notEqual(codex.status, 0);
    const { error } = JSON.parse(codex.stdout);
    assert.equal(error.code, 'BOARD_NOT_WRITABLE');
    assert.match(error.message, /Codex's workspace-write sandbox keeps \.git read-only/u);
    assert.equal(error.next, `restart Codex with that folder writable: codex --add-dir '${folder}'; to keep it in ~/.codex/config.toml, a permission profile takes ${JSON.stringify(folder)} = "write" in its [permissions.<active-profile>.filesystem] table, and only settings without a profile use writable_roots under [sandbox_workspace_write]; then run the command again`);
  } finally { unlockBoard(folder); }
});

test('resume checks both board-file and journal-folder write capability without leaving a probe [I1,L3,P4]', () => {
  for (const blocked of ['file', 'folder']) {
    const p = project();
    const folder = join(p.repo, '.git', 'pullboard');
    const file = join(folder, 'board.sqlite');
    assert.equal(p.run(p.repo, 'resume').code, 0, 'resume succeeds before access is removed');
    const before = readFileSync(file);
    chmodSync(blocked === 'file' ? file : folder, blocked === 'file' ? 0o444 : 0o555);
    try {
      if (blocked === 'file') assert.throws(() => appendFileSync(file, ''), { code: 'EACCES' });
      else assert.throws(() => writeFileSync(join(folder, 'permission-sentinel'), ''), { code: 'EACCES' });
      const result = p.run(p.repo, 'resume', '--json');
      assert.notEqual(result.code, 0, `${blocked}: ${result.out}${result.err}`);
      assert.equal(JSON.parse(result.out).error.code, 'BOARD_NOT_WRITABLE', `${blocked} permission has its own real refusal`);
      assert.equal(readFileSync(file).equals(before), true, 'the readiness check changes no board bytes');
    } finally { chmodSync(blocked === 'file' ? file : folder, blocked === 'file' ? 0o644 : 0o755); }
    assert.equal(p.run(p.repo, 'resume').code, 0, 'the named permission repair restores readiness');
    assert.deepEqual(readdirSync(folder).filter(name => name.startsWith('.write-access-')), [], 'successful and refused checks leave no probe');
  }
});
