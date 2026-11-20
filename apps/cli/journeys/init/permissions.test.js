/** Init adds only the requested project-local agent loop permissions and can skip them [I1,I2]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  join,
  parse,
  resolve,
} from 'node:path';
import { test } from 'node:test';
import { machineHomeWriteScopeIsNarrow } from '../../index.js';
import { machineHome } from '../../../../packages/resources/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

const BIN = resolve(import.meta.dirname, '../../pullboard.js');

/** Create a real private Git project with isolated board and machine homes. */
function initFixture(t, { existingSettings, existingCodexRules } = {}) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-init-permissions-')));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, 'repo');
  const bin = join(temp, 'bin');
  mkdirSync(root);
  mkdirSync(bin);
  const env = {
    ...process.env,
    HOME: join(temp, 'home'),
    PULLBOARD_HOME: join(temp, 'board-home'),
    PULLBOARD_MACHINE_HOME: join(temp, 'machine-home'),
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Init Permissions Fixture',
    GIT_AUTHOR_EMAIL: 'init-permissions@example.invalid',
    GIT_COMMITTER_NAME: 'Init Permissions Fixture',
    GIT_COMMITTER_EMAIL: 'init-permissions@example.invalid',
  };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'].includes(key)) delete env[key];
  for (const key of ['PULLBOARD_RELAY_TOKEN', 'PULLBOARD_AGENT', 'PULLBOARD_AGENT_ID']) delete env[key];
  writeFileSync(join(bin, 'pullboard'), `#!/bin/sh\nexec "${process.execPath}" "${BIN}" "$@"\n`);
  chmodSync(join(bin, 'pullboard'), 0o755);
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, env });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'init-permissions-fixture', scripts: { test: 'node --test' } }));
  if (existingSettings !== undefined) {
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'), `${JSON.stringify(existingSettings, null, 2)}\n`);
  }
  if (existingCodexRules !== undefined) {
    mkdirSync(join(root, '.codex', 'rules'), { recursive: true });
    writeFileSync(join(root, '.codex', 'rules', 'pullboard.rules'), existingCodexRules);
  }
  /** Invoke the real init command in JSON mode and preserve its status/document. */
  async function init(...args) {
    const child = await runCliInProcess(['init', ...args, '--json'], { cwd: root, env });
    return { code: child.status, document: child.stdout ? JSON.parse(child.stdout) : null, stderr: child.failure ?? child.stderr };
  }
  return { root, env, init };
}

/** Resolve the fixture's real Pullboard machine home, while giving HOME a distinct decoy path. */
function actualMachineHome(env) {
  const priorHome = process.env.HOME;
  const priorMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  try {
    process.env.HOME = env.HOME;
    process.env.PULLBOARD_MACHINE_HOME = env.PULLBOARD_MACHINE_HOME;
    return machineHome();
  } finally {
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    if (priorMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = priorMachineHome;
  }
}

/** Parse Codex argv-prefix rules without depending on JSON whitespace. */
function codexPrefixes(contents) {
  return contents.split(/\r?\n/u)
    .filter(line => line.startsWith('prefix_rule('))
    .map((line) => {
      const match = line.match(/^prefix_rule\(pattern=(\[[^\]]*\]), decision="allow"/u);
      assert.ok(match, `Codex rule has a parseable prefix: ${line}`);
      return JSON.parse(match[1]);
    });
}

test('cli.journeys-init-permissions.init-grants-the-agent-the-permissions: init grants the agent the permissions the Pullboard loop needs [I1,I2]', async t => {
  const syntheticHome = join(resolve(tmpdir()), 'permission-scope-user');
  assert.equal(machineHomeWriteScopeIsNarrow(join(syntheticHome, '.pullboard'), syntheticHome), true, 'a private machine-home below the OS home is eligible for a write grant');
  assert.equal(machineHomeWriteScopeIsNarrow(syntheticHome, syntheticHome), false, 'the OS home itself is never granted');
  assert.equal(machineHomeWriteScopeIsNarrow(resolve(syntheticHome, '..'), syntheticHome), false, 'an ancestor containing the OS home is never granted');
  assert.equal(machineHomeWriteScopeIsNarrow(parse(syntheticHome).root, syntheticHome), false, 'a filesystem root is never granted');

  const scopeFixture = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-machine-home-symlink-')));
  t.after(() => rmSync(scopeFixture, { recursive: true, force: true }));
  const simulatedHome = join(scopeFixture, 'os-home');
  mkdirSync(simulatedHome);
  const homeAlias = join(scopeFixture, 'home-alias');
  symlinkSync(simulatedHome, homeAlias, 'dir');
  assert.equal(machineHomeWriteScopeIsNarrow(homeAlias, simulatedHome), false, 'a symlink that grants the entire OS home is refused');
  assert.equal(machineHomeWriteScopeIsNarrow(join(homeAlias, '.pullboard'), simulatedHome), true, 'a missing private machine-home below the canonical home remains eligible');
  const danglingAlias = join(scopeFixture, 'dangling-home-alias');
  symlinkSync(join(scopeFixture, 'missing-home'), danglingAlias, 'dir');
  assert.equal(machineHomeWriteScopeIsNarrow(danglingAlias, simulatedHome), false, 'an unresolvable existing symlink fails closed');

  const fresh = initFixture(t);
  const freshInit = await fresh.init();
  assert.equal(freshInit.code, 0, freshInit.stderr);
  const freshSettings = JSON.parse(readFileSync(join(fresh.root, '.claude', 'settings.json'), 'utf8'));
  const freshMachineHome = actualMachineHome(fresh.env);
  assert.ok(freshSettings.permissions?.allow?.includes('Bash(pullboard:*)'), 'fresh projects receive Claude loop rules');
  assert.deepEqual(freshSettings.sandbox?.filesystem?.allowWrite, [freshMachineHome], 'Claude sandbox can write only to Pullboard machine home');
  assert.notEqual(freshMachineHome, fresh.env.HOME, 'the effective machine home ignores HOME when an explicit machine-home override is set');
  const freshCodexRules = readFileSync(join(fresh.root, '.codex', 'rules', 'pullboard.rules'), 'utf8');
  assert.deepEqual(codexPrefixes(freshCodexRules), [['pullboard'], ['git', 'status'], ['git', 'diff'], ['git', 'log'], ['git', 'add'], ['git', 'commit'], ['git', 'merge'], ['git', 'rebase'], ['git', 'switch'], ['git', 'checkout'], ['git', 'worktree'], ['npm', 'test']], 'fresh projects receive only the required Codex command prefixes');

  const existing = {
    custom: { keep: true },
    hooks: { UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: 'existing-hook' }] }] },
    permissions: {
      allow: ['Bash(existing command *)'],
      ask: ['Bash(git push *)'],
      deny: ['Bash(rm -rf *)'],
    },
    sandbox: { enabled: true, filesystem: { allowWrite: ['/tmp/existing-write'], denyWrite: ['/tmp/existing-deny'] } },
  };
  const box = initFixture(t, { existingSettings: existing, existingCodexRules: '# user rule stays\n' });
  const existingCodexConfig = `sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nwritable_roots = ["/tmp/existing-codex-root"]\n`;
  mkdirSync(join(box.root, '.codex'), { recursive: true });
  const codexConfigPath = join(box.root, '.codex', 'config.toml');
  writeFileSync(codexConfigPath, existingCodexConfig);
  const initialized = await box.init();
  assert.equal(initialized.code, 0, initialized.stderr);

  const settingsPath = join(box.root, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(settings.custom, existing.custom, 'unrelated settings remain unchanged');
  assert.deepEqual(settings.hooks.UserPromptSubmit, existing.hooks.UserPromptSubmit, 'existing hooks remain unchanged');
  assert.ok(settings.hooks.SessionStart, 'the existing Pullboard resume hook remains installed');
  assert.deepEqual(settings.permissions.ask, existing.permissions.ask, 'existing ask rules remain unchanged');
  assert.deepEqual(settings.permissions.deny, existing.permissions.deny, 'existing deny rules remain unchanged');
  const machineHomePath = actualMachineHome(box.env);
  assert.deepEqual(settings.sandbox.filesystem.allowWrite, ['/tmp/existing-write', machineHomePath], 'the exact machine home is merged with existing sandbox write paths');
  assert.deepEqual(settings.sandbox.filesystem.denyWrite, existing.sandbox.filesystem.denyWrite, 'existing sandbox deny paths remain unchanged');
  const claudeRules = settings.permissions.allow;
  for (const rule of [
    'Bash(pullboard:*)',
    'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git add:*)',
    'Bash(git commit:*)', 'Bash(git merge:*)', 'Bash(git rebase:*)', 'Bash(git switch:*)',
    'Bash(git checkout:*)', 'Bash(git worktree:*)', 'Bash(npm test)',
    'Edit(/**)',
  ]) assert.ok(claudeRules.includes(rule), `Claude project allow rules include ${rule}`);
  assert.equal(claudeRules.includes('Bash(*)'), false, 'all shell commands are never allowed');
  assert.equal(claudeRules.includes('Bash(git:*)'), false, 'all Git commands are never allowed');

  const codexPath = join(box.root, '.codex', 'rules', 'pullboard.rules');
  const codexRules = readFileSync(codexPath, 'utf8');
  assert.ok(codexRules.startsWith('# user rule stays\n'), 'existing project Codex rules are preserved');
  assert.deepEqual(codexPrefixes(codexRules), [['pullboard'], ['git', 'status'], ['git', 'diff'], ['git', 'log'], ['git', 'add'], ['git', 'commit'], ['git', 'merge'], ['git', 'rebase'], ['git', 'switch'], ['git', 'checkout'], ['git', 'worktree'], ['npm', 'test']], 'Codex rules stay scoped to the exact loop commands');
  assert.ok(initialized.document.notes.some(note => /Claude Code.*Pullboard loop/u.test(note)), 'init says what Claude rules it added');
  assert.ok(initialized.document.notes.some(note => /trusted-project Codex rules.*trust this project and restart the session/u.test(note)), 'init explains trust and session restart for Codex rules');
  // The board folder under .git is granted beside the machine home, since Codex keeps .git read-only (#913).
  const expectedLegacyCodex = `sandbox_mode = "workspace-write"\n\n[sandbox_workspace_write]\nwritable_roots = ${JSON.stringify([machineHomePath, join(box.root, '.git', 'pullboard')])}`;
  assert.ok(initialized.document.notes.some(note => note.includes(expectedLegacyCodex)), 'Codex setup prints exact legacy workspace-write values scoped to the machine home');
  assert.ok(initialized.document.notes.some(note => /sandbox_mode at the TOML top level before any table, append these exact paths to any existing writable_roots array while keeping its entries, and do not duplicate the table or replace unrelated settings/u.test(note)), 'Codex setup explains the top-level key and exact append without replacing settings or duplicating the TOML table');
  assert.ok(initialized.document.notes.some(note => /https:\/\/learn\.chatgpt\.com\/docs\/config-file\/config-reference.*https:\/\/learn\.chatgpt\.com\/docs\/permissions/u.test(note)), 'Codex setup cites the official sandbox and permission-profile references');
  const codexAfter = readFileSync(codexConfigPath, 'utf8');
  assert.ok(codexAfter.startsWith(existingCodexConfig), 'init prints Codex configuration guidance without rewriting a project config');
  // The only addition is the pullboard MCP server table (#961); the sandbox settings stay exactly as written.
  assert.match(codexAfter.slice(existingCodexConfig.length), /^\n\[mcp_servers\.pullboard\]\ncommand = "sh"\nargs = \["-c", "[^\n]+"\]\n$/u);
  assert.ok(initialized.document.notes.some(note => /permission-profile users.*existing \[permissions\.<active-profile>\.filesystem\].*do not mix/iu.test(note)), 'Codex setup explains the permission-profile alternative without mixing config systems');
  const profileBoard = `${JSON.stringify(machineHomePath)} = "write" and ${JSON.stringify(join(box.root, '.git', 'pullboard'))} = "write" under their existing [permissions.<active-profile>.filesystem] table instead, since a named profile ignores writable_roots`;
  assert.ok(initialized.document.notes.some(note => note.includes(profileBoard)), 'the permission-profile step grants the board folder too (#913)');

  const settingsBytes = readFileSync(settingsPath, 'utf8');
  const codexBytes = readFileSync(codexPath, 'utf8');
  const second = await box.init();
  assert.equal(second.code, 0, second.stderr);
  assert.equal(readFileSync(settingsPath, 'utf8'), settingsBytes, 'repeat init does not duplicate or rewrite Claude rules');
  assert.equal(readFileSync(codexPath, 'utf8'), codexBytes, 'repeat init does not duplicate or rewrite Codex rules');

  const skipFresh = initFixture(t);
  const skipFreshResult = await skipFresh.init('--no-permissions');
  assert.equal(skipFreshResult.code, 0, skipFreshResult.stderr);
  const skipFreshSettings = JSON.parse(readFileSync(join(skipFresh.root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(skipFreshSettings.permissions, undefined, '--no-permissions leaves fresh Claude permissions unset');
  assert.equal(existsSync(join(skipFresh.root, '.codex', 'rules', 'pullboard.rules')), false, '--no-permissions creates no Codex rules file');
  assert.equal(skipFreshResult.document.notes.some(note => /permission rules|trusted-project Codex/u.test(note)), false, '--no-permissions does not claim it installed agent rules');

  const skipExisting = initFixture(t, { existingSettings: existing, existingCodexRules: '# user rule stays\n' });
  const skipSettingsPath = join(skipExisting.root, '.claude', 'settings.json');
  const skipCodexPath = join(skipExisting.root, '.codex', 'rules', 'pullboard.rules');
  const skipPermissions = JSON.parse(readFileSync(skipSettingsPath, 'utf8')).permissions;
  const skipSandbox = JSON.parse(readFileSync(skipSettingsPath, 'utf8')).sandbox;
  const skipCodexBytes = readFileSync(skipCodexPath, 'utf8');
  const skipExistingResult = await skipExisting.init('--no-permissions');
  assert.equal(skipExistingResult.code, 0, skipExistingResult.stderr);
  assert.deepEqual(JSON.parse(readFileSync(skipSettingsPath, 'utf8')).permissions, skipPermissions, '--no-permissions preserves existing Claude permissions');
  assert.deepEqual(JSON.parse(readFileSync(skipSettingsPath, 'utf8')).sandbox, skipSandbox, '--no-permissions preserves existing sandbox scope');
  assert.equal(readFileSync(skipCodexPath, 'utf8'), skipCodexBytes, '--no-permissions preserves existing Codex rules byte-for-byte');
});

test('cli.journeys-init-permissions.init-edits-a-simple-codex-config: init edits a simple Codex config and keeps a pullboard server already there [A9,I1]', async (t) => {
  // Every line is in the simple subset, so init appends the table once, or keeps the file when pullboard is there.
  for (const [existing, codex] of [
    ['[mcp_servers.pullboard] # the team runs it here\ncommand = "pullboard"\nargs = ["mcp"]\n', 'kept'],
    ["[mcp_servers.'pullboard']\ncommand = \"pullboard\"\n", 'kept'],
    ['mcp_servers.pullboard.command = "pullboard"\n', 'kept'],
    ['[mcp_servers]\npullboard.command = "pullboard"\n', 'kept'],
    ['# [mcp_servers.pullboard] was here once\n[mcp_servers.other]\ncommand = "pullboard"\n', 'added'],
    ['[mcp_servers."\\U0001F600"]\ncommand = "smile"\n', 'added'],
    ['model = "o3"\nlimits = [1, 2.5, true, "x"] # trailing\n', 'added'],
  ]) {
    const box = initFixture(t);
    mkdirSync(join(box.root, '.codex'), { recursive: true });
    writeFileSync(join(box.root, '.codex', 'config.toml'), existing);
    const initialized = await box.init();
    assert.equal(initialized.code, 0, `${existing}\n${initialized.stderr}`);
    assert.equal(initialized.document.mcp.codex, codex, existing);
    const after = readFileSync(join(box.root, '.codex', 'config.toml'), 'utf8');
    if (codex === 'kept') assert.equal(after, existing, 'a pullboard server already there is kept byte for byte');
    else {
      assert.ok(after.startsWith(existing), 'everything already there is kept');
      assert.match(after.slice(existing.length), /^\n\[mcp_servers\.pullboard\]\ncommand = "sh"\nargs = \["-c", "[^\n]+"\]\n$/u, 'the pullboard table is appended once');
    }
  }
});

test('cli.journeys-init-permissions.init-leaves-a-codex-config-outside: init leaves a Codex config outside the simple subset as written, prints the exact block and marks Codex manual [A9,I1]', async (t) => {
  // Outside the subset init never rewrites the person's TOML; it prints the one block for them to add.
  for (const existing of [
    'mcp_servers = { other = { command = "other-server", args = ["serve"] } }\n',
    'mcp_servers = {}\n',
    'mcp_servers = { pullboard = { command = "pullboard" } }\n',
    'note = """\n[mcp_servers.pullboard]\n"""\n[mcp_servers.other]\ncommand = "other"\n',
    'released = 1979-05-27\n',
    '[[profiles]]\nname = "x"\n',
  ]) {
    const box = initFixture(t);
    mkdirSync(join(box.root, '.codex'), { recursive: true });
    writeFileSync(join(box.root, '.codex', 'config.toml'), existing);
    const initialized = await box.init();
    assert.equal(initialized.code, 0, `${existing}\n${initialized.stderr}`);
    assert.equal(readFileSync(join(box.root, '.codex', 'config.toml'), 'utf8'), existing, `${existing}: byte for byte as it was`);
    assert.equal(initialized.document.mcp.codex, 'manual', `${existing}: --json marks Codex as manual`);
    const note = initialized.document.notes.find(entry => entry.startsWith('kept .codex/config.toml as written:'));
    assert.match(note ?? '', /\n\[mcp_servers\.pullboard\]\ncommand = "sh"\nargs = \["-c", "[^\n]+"\]$/u, `${existing}: the one exact block to add`);
  }
  // The plain command prints the block too, without --verbose.
  const box = initFixture(t);
  mkdirSync(join(box.root, '.codex'), { recursive: true });
  writeFileSync(join(box.root, '.codex', 'config.toml'), 'mcp_servers = {}\n');
  const plain = await runCliInProcess(['init'], { cwd: box.root, env: box.env });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /\[mcp_servers\.pullboard\]\ncommand = "sh"\nargs = \["-c", /u, 'the plain output shows the block');
});
