import { viewApiPorts } from '../../../view/index.js';
import { AGENT_SHELL_MARKERS } from '../../../../packages/kernel/index.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { nativeBoardPorts as relayPresentationNativePorts } from '../../../lib/index.js';
import { openBoard } from '../../../lib/index.js';
/** The public, versioned JSON surface of every pullboard command (A1). */
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startFixtureChild as spawn } from '../../tests/fixtures/child.js';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { reportFixtureChildFailure } from '../../tests/fixtures/child.js';
import { safeFixtureDiagnostic } from '../../tests/fixtures/child.js';
import { performance } from 'node:perf_hooks';
import { appendFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { main } from '../../tests/fixtures/native.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { main as nativeTestMain } from '../../tests/fixtures/native.js';
import { createLocalApiHandler } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { serveApi } from '../../../../packages/api/index.js';
import * as apiExports from '../../../../packages/api/index.js';
import { allShouts } from '../../../../packages/store/index.js';
import { EVENT_LOG_VERSION } from '../../../../packages/store/index.js';
import { SIGNED_EVENT_LOG_VERSION } from '../../../../packages/store/index.js';
import { closeBoard } from '../../../../packages/store/index.js';
import { events as boardEvents } from '../../../../packages/store/index.js';
import { verdictsFor } from '../../../../packages/store/index.js';
import { presentationShout } from '../../../../packages/pages/index.js';
import { relayPresentation } from '../../../../packages/pages/index.js';
import { JSON_SHAPES } from '../../../../packages/config/index.js';
import { projectState } from '../../src/io/view.js';
import { serveView } from '../../src/io/commands/view.js';
import { registerProject } from '../../../../packages/seats/index.js';
import { apiError } from '../../tests/fixtures/api.js';
import { apiFetch } from '../../tests/fixtures/api.js';
import { fixtureCommandEvidence } from '../../tests/fixtures/api.js';
import { assertRequiredShape } from '../../tests/fixtures/api.js';
import { nextSseEvent } from '../../tests/fixtures/api.js';
import { timedMs } from '../../tests/fixtures/api.js';
import { addRoutedItem } from '../../tests/fixtures/api.js';
import { addLightViaCli } from '../../tests/fixtures/api.js';
import { commitWork } from '../../tests/fixtures/api.js';
import { checkOutSubmitted } from '../../tests/fixtures/api.js';
import { json } from '../../tests/fixtures/api/project.js';
import { project } from '../../tests/fixtures/api/project.js';
import { sandbox } from '../../tests/fixtures/api/project.js';
import { readEventLogVersion } from '../../tests/fixtures/api/project.js';
import { setEventLogVersion } from '../../tests/fixtures/api/project.js';
import { shapeFor } from '../../tests/fixtures/api/project.js';
import { SPEC } from '../../tests/fixtures/api/project.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
// The newest event-log format this Pullboard reads: a board with signed person moves is format 2 [E22].
const READABLE_EVENT_LOG = Math.max(EVENT_LOG_VERSION, SIGNED_EVENT_LOG_VERSION);
const BIN = resolve(import.meta.dirname, '../../pullboard.js');
test('apiBoardListing is exported and matches the board list [A2]', async (t) => {
  const apiBoardListing = apiExports.apiBoardListing;
  assert.equal(typeof apiBoardListing, 'function', 'the existing API listing classifier is exported');
  const box = project();
  const unreadableRoot = join(box.dir, 'unreadable');
  mkdirSync(unreadableRoot);
  const projects = () => [
    { root: box.repo, name: 'Readable fixture', project: 'API parity', added: '2026-10-23T00:00:00.000Z' },
    { root: unreadableRoot, name: 'Unreadable fixture', project: 'API parity', added: '2026-10-23T00:00:00.000Z' },
  ];
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, runCommand: main, projects });
  t.after(() => api.close());
  const address = new URL(api.url);
  const response = await apiFetch({ origin: address.origin, secret: address.searchParams.get('k') }, '/api/v1/boards');
  assert.equal(response.status, 200);
  const listed = await response.json();
  assert.deepEqual({ version: 1, ...apiBoardListing(projects, undefined, refusalDocument, apiBoardOpeners) }, listed);
  assert.deepEqual(listed.boards.map(({ root }) => root), [box.repo]);
  assert.deepEqual(listed.warnings.map(({ root, error }) => [root, error.error.code]), [[unreadableRoot, 'BOARD_UNAVAILABLE']]);
});
test('[A5] append-only event records expose format version one', () => {
  assert.equal(EVENT_LOG_VERSION, 1);
});
test('[O8] authenticated API state exposes model labels and configured stable display names', async (t) => {
  const box = project();
  const created = await runLocal(box, box.repo, 'worktree', 'app', '--model', 'Claude Sonnet', '--json');
  assert.equal(created.status, 0, created.stderr || created.stdout);
  const createdAgent = JSON.parse(created.stdout);
  assert.equal(createdAgent.agent, 'app-1');
  assert.equal(createdAgent.model, 'Claude Sonnet');
  const api = await startApi(t, box);
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const board = boards.boards.find((entry) => entry.root === box.repo);
  assert.ok(board?.id);
  const stateUrl = `/api/v1/boards/${board.id}/state`;
  const suffixResponse = await apiFetch(api, stateUrl);
  assert.equal(suffixResponse.status, 200);
  const suffix = (await suffixResponse.json()).state.agents;
  const suffixAgent = suffix.find((agent) => agent.agent_id === 'app-1');
  assert.equal(suffixAgent.model, 'Claude Sonnet');
  assert.equal(suffixAgent.displayName, 'app-1 (Claude Sonnet)');
  const legacy = suffix.find((agent) => agent.agent_id === 'coordinator');
  assert.equal(legacy.model, 'unknown');
  assert.equal(legacy.displayName, 'coordinator (unknown)');
  const configFile = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  config.agents = { names: 'prefix' };
  writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
  const prefixResponse = await apiFetch(api, stateUrl);
  assert.equal(prefixResponse.status, 200);
  const prefix = (await prefixResponse.json()).state.agents;
  assert.equal(prefix.find((agent) => agent.agent_id === 'app-1').agent_id, 'app-1', 'display styles do not change stable ids');
  assert.equal(prefix.find((agent) => agent.agent_id === 'app-1').displayName, 'claude-sonnet-app-1');
  assert.equal(prefix.find((agent) => agent.agent_id === 'coordinator').displayName, 'unknown-coordinator');
});
test('[A2] the local API admits only its listed origins', async (t) => {
  const box = project();
  const listedOrigin = 'https://app.pullboard.dev';
  const configured = await startLocalHandler(t, box, { allowedOrigins: [listedOrigin] });
  const listed = await apiFetch(configured, '/api/v1/boards', { headers: { origin: listedOrigin } });
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).boards.length, 1, 'the allowed origin reaches the regular board handler');
  for (const origin of [
    'https://app.pullboard.dev.attacker.invalid',
    'https://sub.app.pullboard.dev',
    'https://app.pullboard.dev:444',
    'https://different.invalid',
  ]) {
    const response = await apiFetch(configured, '/api/v1/boards', { headers: { origin } });
    assert.equal((await apiError(response, 403)).code, 'API_ORIGIN', `an unlisted origin is refused: ${origin}`);
  }
  const missingKey = await apiFetch(configured, '/api/v1/boards', { noSecret: true, headers: { origin: listedOrigin } });
  assert.equal((await apiError(missingKey, 401)).code, 'AUTH_REQUIRED', 'an allowed origin still needs the session key');
  const wrongKey = await apiFetch(configured, '/api/v1/boards', { headers: { origin: listedOrigin, 'x-pullboard-key': randomUUID() } });
  assert.equal((await apiError(wrongKey, 401)).code, 'AUTH_REQUIRED', 'an allowed origin does not replace the session key');
  const defaulted = await startLocalHandler(t, box);
  const defaultOrigin = await apiFetch(defaulted, '/api/v1/boards', { headers: { origin: listedOrigin } });
  assert.equal((await apiError(defaultOrigin, 403)).code, 'API_ORIGIN', 'omitting the option preserves same-origin-only behavior');
});
test('local API admits only configured literal IPv4 hosts at their own origin [H19]', async (t) => {
  const box = project();
  const configured = await startLocalHandler(t, box, { allowedHosts: ['192.168.7.9'] });
  const port = new URL(configured.origin).port;
  const host = `192.168.7.9:${port}`;
  const origin = `http://${host}`;
  const allowed = await apiFetch(configured, '/api/v1/boards', { headers: { host, origin } });
  assert.equal(allowed.status, 200, 'the exact configured IPv4 Host and same Origin reach the API');
  assert.equal((await allowed.json()).boards.length, 1);
  assert.equal((await apiFetch(configured, '/api/v1/boards')).status, 200, 'loopback remains allowed');
  const foreignHost = await apiFetch(configured, '/api/v1/boards', { headers: { host: `192.168.7.10:${port}`, origin: `http://192.168.7.10:${port}` } });
  assert.equal((await apiError(foreignHost, 401)).code, 'AUTH_REQUIRED');
  const foreignOrigin = await apiFetch(configured, '/api/v1/boards', { headers: { host, origin: 'https://foreign.invalid' } });
  assert.equal((await apiError(foreignOrigin, 403)).code, 'API_ORIGIN');
  const defaulted = await startLocalHandler(t, box);
  const denied = await apiFetch(defaulted, '/api/v1/boards', { headers: { host, origin } });
  assert.equal((await apiError(denied, 401)).code, 'AUTH_REQUIRED', 'omitting the allowlist preserves loopback-only Host authority');
  for (const invalid of ['localhost', '0.0.0.0', '2001:db8::1', '192.168.7', '192.168.7.256', '192.168.007.9', '192.168.7.9:80']) assert.throws(() => createLocalApiHandler({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument,
    secret: randomUUID(), getPort: () => 1, runCommand: main, projects: () => [], allowedHosts: [invalid],
  }), TypeError, `invalid LAN host ${invalid} is rejected`);
});
test('[A5] board opens upgrade older event logs and refuse future event logs before migration', async () => {
  const box = project();
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  assert.equal(readEventLogVersion(file), String(EVENT_LOG_VERSION));

  const future = READABLE_EVENT_LOG + 1;
  setEventLogVersion(file, future);
  const refused = await runLocal(box, box.repo, 'status', '--json');
  assert.equal(refused.status, 1, refused.stderr);
  const refusal = JSON.parse(refused.stdout).error;
  assert.equal(refusal.code, 'EVENT_LOG_VERSION');
  assert.match(refusal.message, new RegExp(`event log version ${future}.*version ${READABLE_EVENT_LOG}`));
  assert.match(refusal.next, /upgrade pullboard/i);
  assert.equal(readEventLogVersion(file), String(future), 'a future-format refusal leaves the stored version untouched');

  const partialFile = join(box.dir, 'partial-future.sqlite');
  const partial = new DatabaseSync(partialFile);
  partial.exec("CREATE TABLE board_meta (meta_key TEXT PRIMARY KEY, meta_value TEXT NOT NULL)");
  partial.prepare('INSERT INTO board_meta (meta_key, meta_value) VALUES (?, ?)').run('event_log_version', String(future));
  partial.close();
  assert.throws(() => openBoard(partialFile), { code: 'EVENT_LOG_VERSION' });
  const unchanged = new DatabaseSync(partialFile);
  try {
    assert.equal(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item'").get(), undefined,
      'refusing a future event log rolls back schema creation on an older database');
    assert.equal(unchanged.prepare('SELECT meta_value FROM board_meta WHERE meta_key = ?').get('event_log_version').meta_value, String(future));
  } finally { unchanged.close(); }

  setEventLogVersion(file, EVENT_LOG_VERSION - 1);
  const release = join(box.dir, 'installed-release');
  mkdirSync(release);
  copyPackageFiles(resolve(import.meta.dirname, '../../../..'), release);
  const older = spawnSync(process.execPath, [join(release, 'apps/cli/pullboard.js'), 'shout', 'all', 'board upgrade', '--json'], { cwd: box.repo, env: box.env, encoding: 'utf8' });
  assert.equal(older.status, 0, older.stderr + older.stdout);
  assert.equal(readEventLogVersion(file), String(EVENT_LOG_VERSION), 'an installed release opens an older event log and upgrades its marker in place');
});

/** Run the CLI in this process with the box's environment; same result shape as box.run, awaited [C7]. */
const runLocal = (box, cwd, ...args) => runCliInProcess(args, { cwd, env: box.env });
/** Run a named CLI JSON step and retain its stdout, exit code and timing for assertions. */
async function fixtureJsonStep(box, step, cwd, command, args = [], expectedStatus = 0, onEvidence) {
  const result = await runLocal(box, cwd, command, ...args, '--json');
  const evidence = fixtureCommandEvidence(step, result, box.env);
  onEvidence?.(evidence);
  assert.equal(result.status, expectedStatus, evidence);
  assert.equal(result.stderr, '', evidence);
  let document;
  try { document = JSON.parse(result.stdout); }
  catch (error) { assert.fail(`${evidence}\ninvalid JSON: ${error.message}`); }
  assert.ok(document !== null && typeof document === 'object' && !Array.isArray(document),
    `${step} JSON response must be an object\n${evidence}`);
  assert.equal(document.version, 1, evidence);
  if (expectedStatus === 0) {
    assertRequiredShape(document, shapeFor(command).required, `${step} JSON\n${evidence}`);
  } else {
    assertRequiredShape(document, JSON_SHAPES.error.required, `${step} error JSON\n${evidence}`);
    assertRequiredShape(document.error, JSON_SHAPES.errorFields, `${step} error fields\n${evidence}`);
  }
  return { document, evidence };
}

/** Run one named API step and preserve its status, elapsed time and response body on failure. */
async function apiStep(step, request, env, expectedStatus = 200) {
  const started = performance.now();
  let response;
  try { response = await request; }
  catch (error) { throw new Error(`${step}: HTTP request failed after ${Math.round(performance.now() - started)}ms; response unavailable: ${error.message}`, { cause: error }); }
  let body;
  try { body = await response.text(); }
  catch (error) { throw new Error(`${step}: HTTP ${response.status}; response body read failed after ${Math.round(performance.now() - started)}ms: ${error.message}`, { cause: error }); }
  const evidence = `${step}\nHTTP status: ${response.status}\nElapsed: ${Math.round(performance.now() - started)}ms\nBody: ${safeFixtureDiagnostic(body, env)}`;
  assert.equal(response.status, expectedStatus, evidence);
  let document;
  try { document = JSON.parse(body); }
  catch (error) { assert.fail(`${evidence}\ninvalid JSON: ${error.message}`); }
  return { document, evidence };
}

/** Check one refusal document, including the exact public code, message and next step. */
async function jsonError(box, cwd, command, args, { status, code, message, next }, subcommand) {
  const result = await runLocal(box, cwd, command, ...args, '--json');
  assert.equal(result.status, status, `${command}: ${result.stdout}${result.stderr}`);
  assert.equal(result.stderr, '', `${command} refusal must be JSON-only`);
  const document = JSON.parse(result.stdout);
  assert.equal(document.version, 1);
  assertRequiredShape(document, JSON_SHAPES.error.required, 'error envelope');
  assertRequiredShape(document.error, JSON_SHAPES.errorFields, 'error');
  if (subcommand) shapeFor(command, subcommand);
  assert.deepEqual(document.error, { code, message, next });
  return document;
}

/** Assert only that output is a single JSON value with no second document. */
function parseOneDocument(stdout) {
  const document = JSON.parse(stdout);
  assert.equal(document.version, 1);
  return document;
}

test('[A5, A6] a future-schema worktree cannot migrate the shared board; main can still upgrade it', () => {
  const box = sandbox();
  const repo = join(box.dir, 'repo');
  const sourceRoot = resolve(import.meta.dirname, '../../../..');
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
    assert.deepEqual(staged, ordinary, 'the staged path uses the exact API projectState projection');
    assert.doesNotThrow(() => board.db.prepare('SELECT 1').get(), 'the caller retains ownership of its borrowed board connection');
  } finally { closeBoard(board); }
});

test('[N26,A2] roadmap text, JSON and API state follow live local and registered repo items', async (t) => {
  const box = project();
  const foreign = project();
  const foreignConfigFile = join(foreign.repo, 'pullboard.json');
  const foreignConfig = JSON.parse(readFileSync(foreignConfigFile, 'utf8'));
  foreignConfig.name = 'foreign';
  writeFileSync(foreignConfigFile, `${JSON.stringify(foreignConfig, null, 2)}\n`);
  const registryFile = join(box.env.PULLBOARD_HOME, 'projects.json');
  const registry = JSON.parse(readFileSync(registryFile, 'utf8'));
  registry.projects.push({ root: foreign.repo, name: 'foreign', project: '', added: '2026-10-08T00:00:00.000Z' });
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);

  const addArgs = (title) => [
    'app', title, '--route', 'mid', '--criterion', 'roadmap item', '--check', 'true',
    '--brief', 'Files:\n- app/roadmap.js\nChange: track this work\nTest: inspect its status',
  ];
  const localItem = addLightViaCli(json, box, box.repo, addArgs('Local release')).item;
  const externalItem = addLightViaCli(json, foreign, foreign.repo, addArgs('External follow-up')).item;
  const worktree = json(box, box.repo, 'worktree', ['app', '--route', 'light'], 'worktree');

  json(box, box.repo, 'milestone', ['add', 'Delivery', '--note', 'Ship the release', '--reason', 'Arrange fixture release', '--items', `${localItem.item_id},foreign#${externalItem.item_id}`], 'add');
  json(box, box.repo, 'milestone', ['add', 'Aftercare'], 'add');
  json(box, box.repo, 'milestone', ['move', 'Aftercare', '--before', 'Delivery'], 'move');
  await jsonError(box, worktree.path, 'milestone', ['add', 'Forbidden'], {
    status: 1,
    code: 'COORDINATOR_ONLY',
    message: 'only the coordinator changes milestones; ask your coordinator to update the roadmap',
    next: 'ask your coordinator to update the roadmap',
  }, 'add');
  const claim = await runLocal(box, worktree.path, 'claim', String(localItem.item_id), '--json');
  assert.equal(claim.status, 0, claim.stderr || claim.stdout);

  const textRoadmap = await runLocal(box, box.repo, 'roadmap');
  assert.equal(textRoadmap.status, 0, textRoadmap.stderr);
  assert.ok(textRoadmap.stdout.includes('Aftercare: 0/0 landed') && textRoadmap.stdout.indexOf('Aftercare: 0/0 landed') < textRoadmap.stdout.indexOf('Delivery: 0/2 landed'),
    'the roadmap counts landed items, in milestone order');
  assert.match(textRoadmap.stdout, /Ship the release/);
  assert.match(textRoadmap.stdout, new RegExp(`#${localItem.item_id} Local release — claimed`));
  assert.match(textRoadmap.stdout, new RegExp(`foreign#${externalItem.item_id} External follow-up — open`));

  const document = json(box, box.repo, 'roadmap');
  assert.deepEqual(document.milestones.map(({ name }) => name), ['Aftercare', 'Delivery']);
  assert.deepEqual(document.milestones[1].items.map(({ status }) => status), ['claimed', 'open']);
  const api = await startApi(t, box);
  const listing = await (await apiFetch(api, '/api/v1/boards')).json();
  const current = listing.boards.find((candidate) => candidate.root === box.repo);
  const response = await apiFetch(api, `/api/v1/boards/${current.id}/state`);
  const state = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(state.state.milestones, document.milestones);
});

/** Serve the local API adapter directly so tests can exercise its optional origin allowlist. */
async function startLocalHandler(t, box, options = {}) {
  const secret = randomUUID();
  let port = 0;
  const handler = createLocalApiHandler({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument,
    secret,
    getPort: () => port,
    runCommand: options.runCommand ?? main,
    projects: () => [{ root: box.repo, name: 'API fixture', project: '', added: '2026-01-01T00:00:00.000Z' }],
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    ...(options.onStateBuild === undefined ? {} : { onStateBuild: options.onStateBuild }),
    ...(options.onItemBuild === undefined ? {} : { onItemBuild: options.onItemBuild }),
    ...(options.stateDetail === undefined ? {} : { stateDetail: options.stateDetail }),
    ...(options.personChannel === undefined ? {} : { personChannel: options.personChannel }),
  });
  const server = createServer(handler);
  await new Promise((resolveReady, rejectReady) => {
    server.once('error', rejectReady);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolveReady();
    });
  });
  let stopped = false;
  const close = async () => {
    if (stopped) return;
    stopped = true;
    handler.close();
    const closed = new Promise((resolveClosed) => server.close(resolveClosed));
    server.closeAllConnections();
    await closed;
  };
  t.after(close);
  return { origin: `http://127.0.0.1:${port}`, secret, close };
}

/** Start the real local API server and stop it when its test finishes. */
async function startApi(t, box, { traceStartup = false, traceFile: requestedTraceFile, readinessTimeoutMs = 10_000,
  holdPhase, phaseReachedFile, releaseFile } = {}) {
  const traceFile = requestedTraceFile ?? (traceStartup
    ? process.env.PULLBOARD_STARTUP_TRACE_FILE ?? join(box.dir, 'serve-startup-trace.jsonl')
    : process.env.PULLBOARD_STARTUP_TRACE_FILE);
  const preloadFile = traceFile ? join(box.dir, 'startup-trace-preload.mjs') : null;
  const childEnv = traceFile ? { ...box.env, PULLBOARD_STARTUP_TRACE_FILE: traceFile,
    PULLBOARD_STARTUP_TRACE_ENTRY: BIN,
    ...(holdPhase ? { PULLBOARD_STARTUP_TEST_HOLD_PHASE: holdPhase,
      PULLBOARD_STARTUP_TEST_PHASE_REACHED_FILE: phaseReachedFile,
      PULLBOARD_STARTUP_TEST_RELEASE_FILE: releaseFile } : {}) } : box.env;
  const startedAt = performance.now();
  const args = traceFile
    ? ['--import', preloadFile, BIN, 'serve', '--port', '0', '--json']
    : [BIN, 'serve', '--port', '0', '--json'];
  if (traceFile) {
    const preloadLines = [
      "import fs from 'node:fs';",
      "import { syncBuiltinESMExports } from 'node:module';",
      "import { loadavg } from 'node:os';",
      "import { performance } from 'node:perf_hooks';",
      'const originalAppendFileSync = fs.appendFileSync.bind(fs);',
      'fs.appendFileSync = (path, data, ...options) => {',
      '  const result = originalAppendFileSync(path, data, ...options);',
      "  if (String(path) === process.env.PULLBOARD_STARTUP_TRACE_FILE && process.env.PULLBOARD_STARTUP_TEST_HOLD_PHASE) {",
      "    const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);",
      "    for (const line of text.split('\\n')) {",
      '      let event;',
      '      try { event = JSON.parse(line); } catch { continue; }',
      '      if (event.phase !== process.env.PULLBOARD_STARTUP_TEST_HOLD_PHASE) continue;',
      "      originalAppendFileSync(process.env.PULLBOARD_STARTUP_TEST_PHASE_REACHED_FILE, 'phase reached\\n');",
      '      const waitCell = new Int32Array(new SharedArrayBuffer(4));',
      '      while (!fs.existsSync(process.env.PULLBOARD_STARTUP_TEST_RELEASE_FILE)) Atomics.wait(waitCell, 0, 0, 25);',
      '      break;',
      '    }',
      '  }',
      '  return result;',
      '};',
      'syncBuiltinESMExports();',
      "originalAppendFileSync(process.env.PULLBOARD_STARTUP_TRACE_FILE, JSON.stringify({ phase: 'process-entry', at: Date.now(), elapsedMs: performance.now(), processId: process.pid, cpuUsage: process.cpuUsage(), loadAverage: loadavg(), eventLoopUtilization: performance.eventLoopUtilization() }) + '\\n');",
    ];
    writeFileSync(preloadFile, `${preloadLines.join('\n')}\n`);
    appendFileSync(traceFile, `${JSON.stringify({ phase: 'parent-spawn', at: Date.now(), elapsedMs: 0, processId: process.pid })}\n`);
  }
  const child = spawn(process.execPath, args, { cwd: box.repo, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (child.exitCode === null) {
      let timeout;
      await Promise.race([closed, new Promise((resolveDone) => { timeout = setTimeout(resolveDone, 10_000); })]);
      clearTimeout(timeout);
    }
  });
  const document = await new Promise((resolveReady, rejectReady) => {
    let settled = false;
    const failStartup = (detail, status = child.exitCode, signal = child.signalCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(phaseWait);
      let startupDiagnostics = '';
      let startupPhases = [];
      if (traceFile) {
        try {
          startupPhases = readFileSync(traceFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
        } catch { /* An unavailable trace is reported as an empty capture. */ }
        const childStartedAt = startupPhases.find(({ phase }) => phase === 'process-entry')?.at ?? startupPhases[0]?.at;
        const phaseLines = startupPhases.map(({ phase, at }) => {
          const elapsed = Number.isFinite(at) && Number.isFinite(childStartedAt) ? Math.max(0, at - childStartedAt) : null;
          return `- ${phase}: ${elapsed === null ? 'time unavailable' : `${elapsed}ms since child start`}`;
        });
        const lastPhase = startupPhases.at(-1)?.phase ?? 'no startup phase was recorded';
        startupDiagnostics = `serve startup phases:\n${phaseLines.length ? phaseLines.join('\n') : '- no startup phases were recorded'}\nlast phase reached: ${lastPhase}`;
        t.diagnostic(startupDiagnostics);
      }
      if (releaseFile && holdPhase) writeFileSync(releaseFile, 'release after timeout trace snapshot\n');
      const failure = new Error(reportFixtureChildFailure({ command: process.execPath, args, status, signal,
        elapsedMs: performance.now() - startedAt, stderr, env: box.env,
        detail: startupDiagnostics ? `${detail}\n${startupDiagnostics}` : detail,
      }));
      failure.startupDiagnostics = startupDiagnostics;
      failure.startupPhases = startupPhases;
      rejectReady(failure);
    };
    let timeout;
    let phaseWait;
    const armReadinessDeadline = () => {
      clearTimeout(timeout);
      timeout = setTimeout(() => failStartup(`serve readiness deadline (${readinessTimeoutMs}ms) expired`), readinessTimeoutMs); // budget: caller-selected ceiling; default remains 10000ms from spawn.
    };
    if (holdPhase && phaseReachedFile) {
      timeout = setTimeout(() => failStartup(`test fixture did not reach startup phase ${holdPhase} within 10000ms`), 10_000); // budget: hang ceiling for deterministic phase arrival only.
      phaseWait = setInterval(() => {
        if (!existsSync(phaseReachedFile)) return;
        clearInterval(phaseWait);
        armReadinessDeadline();
      }, 5);
    } else {
      armReadinessDeadline();
    }
    const check = () => {
      try {
        const parsed = JSON.parse(stdout);
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(phaseWait);
        resolveReady(parsed);
      } catch {
        // The startup envelope is pretty-printed across several chunks.
      }
    };
    child.stdout.on('data', check);
    child.once('error', (error) => failStartup(error.message, null, null));
    child.once('close', (code, signal) => failStartup('serve exited before readiness', code, signal));
    child.once('close', (code) => {
      if (code !== 0) { clearTimeout(timeout); rejectReady(new Error(`serve exited ${code}: ${stderr}`)); }
    });
  });
  if (traceFile) {
    appendFileSync(traceFile, `${JSON.stringify({ phase: 'parent-ready-observed', at: Date.now(), elapsedMs: performance.now() - startedAt, processId: process.pid })}\n`);
  }
  assert.equal(document.version, 1);
  const parsed = new URL(document.url);
  const secret = parsed.searchParams.get('k');
  assert.ok(secret, 'serve startup exposes its per-session secret in its private URL');
  return { child, document, origin: parsed.origin, secret, stderr: () => stderr };
}

test('[N38] local API and sealed presentation resolve shouts beyond recent state, with complete export history', async (t) => {
  const box = project();
  const api = await startApi(t, box);
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const boardId = boards.boards.find((candidate) => candidate.root === box.repo).id;
  const boardPath = `/api/v1/boards/${boardId}`;
  const decision = json(box, box.repo, 'shout', ['person', 'An old decision', '--decision']);
  json(box, box.repo, 'answer', [String(decision.id), 'Approved', '--as', 'person']);
  const openDecision = json(box, box.repo, 'shout', ['person', 'An old open decision', '--decision']);
  for (let index = 0; index < 40; index += 1) json(box, box.repo, 'shout', ['app', `recent message ${index}`]);

  const state = await (await apiFetch(api, `${boardPath}/state`)).json();
  assert.equal(state.state.shouts.length, 40);
  assert.ok(!state.state.shouts.some((shout) => shout.shout_id === decision.id), 'the addressed shout is older than the existing recent-40 state');
  assert.ok(!state.state.shouts.some((shout) => shout.shout_id === openDecision.id));
  const direct = await apiFetch(api, `${boardPath}/shouts/${decision.id}`);
  assert.equal(direct.status, 200);
  const directDocument = await direct.json();
  assertRequiredShape(directDocument, JSON_SHAPES.http.shout.required, 'shout response');
  assert.equal(directDocument.version, JSON_SHAPES.version);
  const oldShout = directDocument.shout;
  assert.equal(oldShout.shout_id, decision.id);
  assert.equal(oldShout.shout_from, 'coordinator');
  assert.equal(oldShout.shout_to, 'person');
  assert.equal(oldShout.shout_text, 'An old decision');
  assert.equal(oldShout.shout_decision, 1);
  assert.equal(oldShout.decision_state, 'answered');
  assert.equal(oldShout.decision_answer.shout_text, 'Approved');
  assert.ok(oldShout.shout_at);
  const open = await (await apiFetch(api, `${boardPath}/shouts/${openDecision.id}`)).json();
  assert.equal(open.shout.decision_state, 'open');
  assert.equal(open.shout.decision_answer, null);

  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let history;
  try { history = allShouts(board); } finally { closeBoard(board); }
  assert.equal(history.length, 43);
  const answer = history.find((shout) => shout.shout_answers === decision.id);
  assert.ok(answer, 'the complete read retains the decision reply relationship');
  assert.equal(answer.shout_text, 'Approved');
  const presentation = relayPresentation(box.repo, {}, relayPresentationNativePorts().presentation);
  assert.throws(() => presentationShout({ state: presentation.state }, decision.id), { code: 'SHOUT_NOT_AVAILABLE' },
    'older snapshots without complete history refuse the capability clearly');
  assert.equal(presentation.shouts.length, 43);
  assert.equal(presentation.shouts[0].shout_id, decision.id);
  assert.equal(presentation.shouts[0].shout_text, 'An old decision');
  assert.equal(presentation.state.shouts.length, 40, 'sealed presentation keeps the state window bounded separately');

  const linkFile = join(box.repo, '.git', 'pullboard', 'relay.json');
  writeFileSync(linkFile, JSON.stringify({ version: 1, mode: 'ordered', board: boardId,
    url: 'https://app.pullboard.dev', repository: 'fixture/repository', token: 'ps_' + 'a'.repeat(43), sequence: 0, cursor: 0 }) + '\n', { mode: 0o600 });
  const throughRelayPresentation = await apiFetch(api, `${boardPath}/shouts/${decision.id}`);
  const relayDocument = await throughRelayPresentation.json();
  assert.equal(throughRelayPresentation.status, 200, JSON.stringify(relayDocument));
  assert.deepEqual(relayDocument.shout, JSON.parse(JSON.stringify(oldShout)));

  const missing = await apiFetch(api, `${boardPath}/shouts/999999`);
  assert.equal((await apiError(missing, 404)).code, 'NO_SHOUT');
  const malformed = await apiFetch(api, `${boardPath}/shouts/0`);
  assert.equal((await apiError(malformed, 400)).code, 'BAD_REQUEST');
  const malformedText = await apiFetch(api, `${boardPath}/shouts/nope`);
  assert.equal((await apiError(malformedText, 400)).code, 'BAD_REQUEST');
  await apiError(await apiFetch(api, `${boardPath}/shouts/${decision.id}`, { noSecret: true }), 401);
  await apiError(await apiFetch(api, `${boardPath}/shouts/${decision.id}`, { headers: { 'x-pullboard-key': 'wrong-session-secret' } }), 401);
  assert.equal((await (await apiFetch(api, `${boardPath}/state`)).json()).state.shouts.length, 40,
    'addressed reads and refusals do not change the recent-40 projection');
});

test('[A2,C7] a missed serve readiness deadline names the slow startup phase', async (t) => {
  const box = project();
  const phaseReachedFile = join(box.dir, 'startup-phase-reached');
  const releaseFile = join(box.dir, 'release-held-startup');
  const traceFile = join(box.dir, 'held-startup-trace.jsonl');
  rmSync(phaseReachedFile, { force: true });
  rmSync(releaseFile, { force: true });
  await assert.rejects(startApi(t, box, {
    traceStartup: true,
    traceFile,
    readinessTimeoutMs: 1_000, // budget: short deterministic observation ceiling after the held registration-start phase.
    holdPhase: 'serve-registration-start',
    phaseReachedFile,
    releaseFile,
  }), (error) => {
    assert.match(error.message, /serve readiness deadline \(1000ms\) expired/);
    assert.match(error.message, /last phase reached: serve-registration-start/);
    assert.match(error.message, /process-entry: \d+ms since child start/);
    assert.match(error.message, /cli-module-load-complete: \d+ms since child start/);
    assert.match(error.message, /cli-command-preamble-ready: \d+ms since child start/);
    assert.match(error.message, /serve-context-start: \d+ms since child start/);
    assert.match(error.message, /serve-context-ready: \d+ms since child start/,
      'the timeout names the recorded context-ready phase');
    assert.ok(error.startupPhases.length > 0, 'the timeout retains its captured phases');
    for (const { phase } of error.startupPhases) assert.ok(error.startupDiagnostics.includes(`- ${phase}:`),
      `the diagnostic lists recorded phase ${phase}`);
    assert.ok(error.message.includes(error.startupDiagnostics), 'the thrown error includes the emitted diagnostic lines');
    assert.deepEqual(error.startupPhases.map(({ phase }) => phase).slice(-1), ['serve-registration-start']);
    assert.match(error.startupDiagnostics, /last phase reached: serve-registration-start/);
    return true;
  });
});

test('[A2] local HTTP v1 versions state and moves, authenticates, and preserves CLI refusals', async (t) => {
  const box = project();
  let lastStepEvidence = 'create local API';
  /** Retain the last completed HTTP step if downstream response inspection fails. */
  async function observedApiStep(...args) {
    const result = await apiStep(...args);
    lastStepEvidence = result.evidence;
    return result;
  }
  /** Retain CLI step evidence before downstream JSON inspection. */
  async function observedFixtureStep(box, step, cwd, command, args = [], expectedStatus = 0) {
    return await fixtureJsonStep(box, step, cwd, command, args, expectedStatus,
      (evidence) => { lastStepEvidence = evidence; });
  }
  try {
    const api = await startApi(t, box, { traceStartup: true });
    /** Validate one captured HTTP refusal while keeping its originating step and response in every failure. */
    function errorDocument(result) {
      assertRequiredShape(result.document, JSON_SHAPES.error.required, `HTTP refusal\n${result.evidence}`);
      assertRequiredShape(result.document.error, JSON_SHAPES.errorFields, `HTTP refusal fields\n${result.evidence}`);
      return result.document.error;
    }

    const boardsStep = await observedApiStep('list registered boards', apiFetch(api, '/api/v1/boards'), box.env);
    assertRequiredShape(boardsStep.document, JSON_SHAPES.http.boards.required, `boards response\n${boardsStep.evidence}`);
    const board = boardsStep.document.boards.find((candidate) => candidate.root === box.repo);
    assert.ok(board?.id, boardsStep.evidence);
    const boardPath = `/api/v1/boards/${board.id}`;

    const missingSecretStep = await observedApiStep('read boards without the session secret', apiFetch(api, '/api/v1/boards', { noSecret: true }), box.env, 401);
    assert.equal(errorDocument(missingSecretStep).code, 'AUTH_REQUIRED', missingSecretStep.evidence);
    const wrongSecretStep = await observedApiStep('read boards with a wrong session secret', apiFetch(api, '/api/v1/boards', { headers: { 'x-pullboard-key': 'wrong-session-secret' } }), box.env, 401);
    assert.equal(errorDocument(wrongSecretStep).code, 'AUTH_REQUIRED', wrongSecretStep.evidence);
    const unknownBoardStep = await observedApiStep('read state for an unknown board', apiFetch(api, `/api/v1/boards/${'0'.repeat(32)}/state`), box.env, 404);
    assert.equal(errorDocument(unknownBoardStep).code, 'NO_BOARD', unknownBoardStep.evidence);

    const stateStep = await observedApiStep('read versioned board state', apiFetch(api, `${boardPath}/state`), box.env);
    assertRequiredShape(stateStep.document, JSON_SHAPES.http.state.required, `state response\n${stateStep.evidence}`);
    assert.equal(stateStep.document.version, 1, stateStep.evidence);
    assert.equal(stateStep.document.eventLogVersion, EVENT_LOG_VERSION, stateStep.evidence);
    const eventsStep = await observedApiStep('read versioned board events', apiFetch(api, `${boardPath}/events?after=0`), box.env);
    assertRequiredShape(eventsStep.document, JSON_SHAPES.http.events.required, `events response\n${eventsStep.evidence}`);
    assert.equal(eventsStep.document.version, 1, eventsStep.evidence);
    assert.equal(eventsStep.document.eventLogVersion, EVENT_LOG_VERSION, eventsStep.evidence);

    const malformedStep = await observedApiStep('reject malformed move JSON', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad json' }), box.env, 400);
    assert.equal(errorDocument(malformedStep).code, 'BAD_REQUEST', malformedStep.evidence);
    const oversizedStep = await observedApiStep('reject an oversized move title', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'x'.repeat(100_001) } }) }), box.env, 400);
    assert.equal(errorDocument(oversizedStep).code, 'BAD_REQUEST', oversizedStep.evidence);
    const unknownVerbStep = await observedApiStep('reject an unknown move verb', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'pretend', args: {} }) }), box.env, 400);
    assert.equal(errorDocument(unknownVerbStep).code, 'BAD_REQUEST', unknownVerbStep.evidence);
    const unknownArgumentStep = await observedApiStep('reject an unknown move argument', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Ignored', extra: true } }) }), box.env, 400);
    assert.equal(errorDocument(unknownArgumentStep).code, 'BAD_REQUEST', unknownArgumentStep.evidence);

    const cliClaimStep = await observedFixtureStep(box, 'claim an unknown item through the CLI', box.repo, 'claim', ['999'], 1);
    const cliRefusal = cliClaimStep.document.error;
    assertRequiredShape(cliRefusal, JSON_SHAPES.errorFields, `CLI claim refusal\n${cliClaimStep.evidence}`);
    const httpClaimStep = await observedApiStep('claim an unknown item through HTTP', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'claim', item: 999, args: {} }) }), box.env, 409);
    assert.deepEqual(errorDocument(httpClaimStep), cliRefusal, `${httpClaimStep.evidence}\nCLI evidence:\n${cliClaimStep.evidence}`);

    const cliNextRun = await runLocal(box, box.repo, 'next', '--json');
    const cliNextStep = { evidence: fixtureCommandEvidence('request available work through the CLI', cliNextRun, box.env) };
    const noWork = JSON.parse(cliNextRun.stdout);
    assert.deepEqual([cliNextRun.status, cliNextRun.stderr, noWork.version, noWork.item, noWork.next, Array.isArray(noWork.reasons)], [0, '', 1, null, 'nothing for this seat: end your turn', true], cliNextStep.evidence);
    const httpNextStep = await observedApiStep('request available work through HTTP', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'next', args: {} }) }), box.env);
    assert.deepEqual(httpNextStep.document, { version: 1, event: null, result: noWork }, `${httpNextStep.evidence}\nCLI evidence:\n${cliNextStep.evidence}`);

    const cliVerifyStep = await observedFixtureStep(box, 'verify an unknown item through the CLI', box.repo, 'verify', ['999', 'accept', '--as', 'coordinator', '--note', 'checked the API'], 1);
    const verifierRefusal = cliVerifyStep.document.error;
    assertRequiredShape(verifierRefusal, JSON_SHAPES.errorFields, `CLI verify refusal\n${cliVerifyStep.evidence}`);
    const httpVerifyStep = await observedApiStep('verify an unknown item through HTTP', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'verify', item: 999, args: { decision: 'accept', as: 'coordinator', note: 'checked the API' } }) }), box.env, 409);
    assert.deepEqual(errorDocument(httpVerifyStep), verifierRefusal, `${httpVerifyStep.evidence}\nCLI evidence:\n${cliVerifyStep.evidence}`);

    const movedStep = await observedApiStep('add a move with a dash-prefixed title', apiFetch(api, `${boardPath}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: '--help' } }) }), box.env);
    assertRequiredShape(movedStep.document, JSON_SHAPES.http.move.required, `move response\n${movedStep.evidence}`);
    assert.ok(movedStep.document.result?.item && typeof movedStep.document.result.item === 'object',
      `add response must include its nested item\n${movedStep.evidence}`);
    assert.equal(movedStep.document.result.item.item_title, '--help', movedStep.evidence);
    assert.equal(movedStep.document.event.event_kind, 'add', movedStep.evidence);
    const emitted = (await (await apiFetch(api, `${boardPath}/events?after=${eventsStep.document.events.at(-1)?.event_id ?? 0}`)).json()).events;
    assert.ok(emitted.some(event => event.event_id === movedStep.document.event.event_id && event.event_kind === 'add'), `the committed add is in the event stream\n${movedStep.evidence}`);
    assert.equal(api.stderr(), '', movedStep.evidence);
  } catch (error) {
    error.message = `${error.message}\n${lastStepEvidence}`;
    throw error;
  }
});

test('[A2] moves run as the named worktree agent and requests stay visible until answered', async (t) => {
  const box = project();
  let lastStepEvidence = 'join worktree agent';
  /** Retain the last completed HTTP step if its response fails during field access. */
  async function observedApiStep(...args) {
    const result = await apiStep(...args);
    lastStepEvidence = result.evidence;
    return result;
  }
  /** Retain CLI step evidence before downstream response fields are inspected. */
  async function observedFixtureStep(...args) {
    const result = await fixtureJsonStep(...args);
    lastStepEvidence = result.evidence;
    return result;
  }
  try {
    const app = join(box.dir, 'app-1');
    box.git(box.repo, 'worktree', 'add', '-q', '-b', 'app/one', app);
    const joined = await fixtureJoin((...a) => runLocal(box, ...a), app, 'app', '--model', 'fixture-agent', '--route', 'strong');
    lastStepEvidence = fixtureCommandEvidence('join worktree agent', joined, box.env);
    assert.equal(joined.status, 0, lastStepEvidence);
    const api = await startApi(t, box);
    const boardsResponse = await observedApiStep('list registered boards', apiFetch(api, '/api/v1/boards'), box.env);
    const board = boardsResponse.document.boards.find((candidate) => candidate.root === box.repo);
    assert.ok(board, boardsResponse.evidence);
    const path = `/api/v1/boards/${board.id}`;

    const addedStep = await observedApiStep('add API move', apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Agent work' } }) }), box.env);
    const added = addedStep.document;
    const claimedStep = await observedApiStep('claim API move as app-1', apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'next', args: {}, agent: 'app-1' }) }), box.env);
    const claimed = claimedStep.document;
    assert.ok(claimed?.event && typeof claimed.event === 'object', `claim response must contain an event\n${claimedStep.evidence}`);
    assert.equal(claimed.event.event_by, 'app-1', claimedStep.evidence);
    assert.equal(claimed.event.event_kind, 'claim', claimedStep.evidence);
    assert.equal(claimed.result.item.item_id, added.result.item.item_id, claimedStep.evidence);

    const renewedStep = await observedApiStep('renew API move as app-1', apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'next', args: {}, agent: 'app-1' }) }), box.env);
    const renewed = renewedStep.document;
    assert.equal(renewed.result.held, true, renewedStep.evidence);
    assert.equal(renewed.event, null, renewedStep.evidence);
    assert.equal(renewed.result.item.item_id, claimed.result.item.item_id, renewedStep.evidence);

    const escalatedStep = await observedApiStep('escalate API move as app-1', apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'escalate', item: added.result.item.item_id, args: { note: 'Two attempts failed' }, agent: 'app-1' }) }), box.env);
    const escalated = escalatedStep.document;
    assert.equal(escalated.event.event_kind, 'escalate', escalatedStep.evidence);
    const eventsStep = await observedApiStep('read events after escalation', apiFetch(api, `${path}/events?after=${claimed.event.event_id}`), box.env);
    const afterEscalation = eventsStep.document.events;
    assert.deepEqual(afterEscalation.map((event) => event.event_kind), ['escalate', 'shout'], eventsStep.evidence);
    assert.equal(afterEscalation[0].event_id, escalated.event.event_id, eventsStep.evidence);

    const previousHome = process.env.PULLBOARD_HOME;
    process.env.PULLBOARD_HOME = box.env.PULLBOARD_HOME;
    let personView;
    let requestStep;
    try {
      registerProject(box.repo);
      personView = await serveView({ port: 0, runCommand: nativeTestMain });
      const viewUrl = new URL(personView.url);
      requestStep = await observedApiStep('create person request through the actual view', apiFetch({
        origin: viewUrl.origin,
        secret: viewUrl.searchParams.get('k'),
      }, `${path}/requests`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'Approve the API row' }),
      }), box.env);
    } finally {
      try { await personView?.close(); }
      finally {
        if (previousHome === undefined) delete process.env.PULLBOARD_HOME;
        else process.env.PULLBOARD_HOME = previousHome;
      }
    }
    const requested = requestStep.document;
    assertRequiredShape(requested, JSON_SHAPES.http.request.required, `create person request\n${requestStep.evidence}`);
    const requestId = requested.result.id;
    assert.equal(requested.event.event_by, 'person', requestStep.evidence);
    const stateStep = await observedApiStep('read request state before answering', apiFetch(api, `${path}/state`), box.env);
    const state = stateStep.document.state;
    assert.deepEqual(state.requests.map((entry) => entry.shout_id), [requestId], stateStep.evidence);
    assert.ok(!state.decisions.some((entry) => entry.shout_id === requestId), `person requests are not open decisions\n${stateStep.evidence}`);
    const inboxStep = await observedFixtureStep(box, 'read coordinator inbox', box.repo, 'inbox');
    const inbox = inboxStep.document;
    assert.equal(inbox.shouts[0].shout_id, requestId, inboxStep.evidence);
    const resumeStep = await observedFixtureStep(box, 'read coordinator resume', box.repo, 'resume');
    const resumed = resumeStep.document;
    assert.equal(resumed.requests[0].shout_id, requestId, resumeStep.evidence);

    const answerStep = await observedApiStep('answer request through API move', apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'answer', item: requestId, args: { text: 'done' } }) }), box.env);
    const answered = answerStep.document;
    assert.equal(answered.event.event_kind, 'answer', answerStep.evidence);
    assert.equal(answered.event.event_by, 'coordinator', answerStep.evidence);
    const finalStateStep = await observedApiStep('confirm request disappears after answer', apiFetch(api, `${path}/state`), box.env);
    assert.deepEqual(finalStateStep.document.state.requests, [], finalStateStep.evidence);
  } catch (error) {
    error.message = `${error.message}\n${lastStepEvidence}`;
    throw error;
  }
});

test('[A2,B25,B26,B27] HTTP decisions preserve routing, passing and explicit person answers', async (t) => {
  const box = project();
  const app = join(box.dir, 'app-1');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'app/one', app);
  assert.equal((await fixtureJoin((...a) => runLocal(box, ...a), app, 'app')).status, 0);
  const api = await startApi(t, box);
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const board = boards.boards.find((candidate) => candidate.root === box.repo);
  const path = `/api/v1/boards/${board.id}`;
  /** Send a real HTTP move while retaining the caller and CLI argument boundaries. */
  const move = (verb, args, item, agent = 'coordinator') => apiFetch(api, `${path}/moves`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb, args, ...(item === undefined ? {} : { item }), agent }),
  });

  const askResponse = await move('shout', { text: 'May this ship?', kind: 'question', decision: true }, undefined, 'app-1');
  assert.equal(askResponse.status, 200);
  const ask = await askResponse.json();
  assert.equal(ask.version, 1);
  assert.equal(ask.event.event_kind, 'shout');
  assert.equal(ask.event.event_by, 'app-1');
  assert.equal(JSON.parse(ask.event.event_detail).to, 'coordinator');

  const notCoordinator = JSON.parse((await runLocal(box, app, 'pass', String(ask.result.id), 'Needs the person', '--json')).stdout).error;
  assert.deepEqual(await apiError(await move('pass', { note: 'Needs the person' }, ask.result.id, 'app-1'), 409), notCoordinator);

  const passResponse = await move('pass', { note: 'Needs the person' }, ask.result.id);
  assert.equal(passResponse.status, 200);
  const passed = await passResponse.json();
  assert.equal(passed.version, 1);
  assert.equal(passed.event.event_kind, 'pass');
  assert.equal(JSON.parse(passed.event.event_detail).to, 'person');

  const personRequired = JSON.parse((await runLocal(box, box.repo, 'answer', String(passed.result.id), 'Approved', '--json')).stdout).error;
  assert.equal(personRequired.code, 'B26_PERSON_ANSWER');
  assert.deepEqual(await apiError(await move('answer', { text: 'Approved' }, passed.result.id), 409), personRequired);
  // A serve key is not the person: an explicit person answer through the standalone API records nothing [P6].
  const eventsBefore = json(box, box.repo, 'log').events.length;
  assert.equal((await apiError(await move('answer', { text: 'Approved', as: 'person' }, passed.result.id), 409)).code, 'B26_PERSON_CHANNEL');
  assert.equal(json(box, box.repo, 'log').events.length, eventsBefore, 'a refused API person answer records no event');
  assert.ok((await (await apiFetch(api, `${path}/state`)).json()).state.decisions.some((entry) => entry.shout_id === passed.result.id),
    'the passed decision still waits for the person');
  // The view's own adapter keeps the person channel, so the person's explicit answer still routes back to the asker.
  const view = await startLocalHandler(t, box);
  const answerResponse = await apiFetch(view, `${path}/moves`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ verb: 'answer', item: passed.result.id, args: { text: 'Approved', as: 'person' }, agent: 'coordinator' }),
  });
  assert.equal(answerResponse.status, 200);
  const answered = await answerResponse.json();
  assert.equal(answered.version, 1);
  assert.equal(answered.event.event_by, 'person');
  assert.equal(answered.event.event_kind, 'answer');
  const replies = json(box, app, 'inbox').shouts;
  assert.ok(replies.some((entry) => entry.shout_answers === ask.result.id && entry.shout_from === 'person' && entry.shout_text.includes('Approved')));
  assert.deepEqual((await (await apiFetch(api, `${path}/state`)).json()).state.decisions, []);
});

test('[A2] SSE delivers a live move and resumes after Last-Event-ID without replay', async (t) => {
  const box = project();
  const api = await startApi(t, box);
  const boards = await (await apiFetch(api, '/api/v1/boards')).json();
  const board = boards.boards.find((candidate) => candidate.root === box.repo);
  const path = `/api/v1/boards/${board.id}`;
  const backlog = await (await apiFetch(api, `${path}/events?after=0`)).json();
  const cursor = backlog.events.at(-1)?.event_id ?? 0;
  const eventUrl = `${path}/events?after=${cursor}`;

  const firstResponse = await apiFetch(api, eventUrl, { headers: { accept: 'text/event-stream' }, signal: AbortSignal.timeout(10_000) });
  assert.equal(firstResponse.status, 200);
  assert.match(firstResponse.headers.get('content-type'), /text\/event-stream/);
  const firstReader = firstResponse.body.getReader();
  const firstPending = { text: '' };
  let firstEvent;
  try {
    const firstMove = await apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Live one' } }) });
    assert.equal(firstMove.status, 200);
    const expectedFirst = await firstMove.json();
    firstEvent = await nextSseEvent(firstReader, firstPending);
    assertRequiredShape(firstEvent.document, JSON_SHAPES.http.stream.required, 'SSE event');
    assert.equal(firstEvent.document.version, 1);
    assert.equal(firstEvent.id, String(expectedFirst.event.event_id));
    assert.deepEqual(firstEvent.document.event, expectedFirst.event);
  } finally {
    await firstReader.cancel();
  }

  const reconnect = await apiFetch(api, `${path}/events`, {
    headers: { accept: 'text/event-stream', 'last-event-id': firstEvent.id },
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(reconnect.status, 200);
  const reader = reconnect.body.getReader();
  try {
    const pending = { text: '' };
    const placement = await nextSseEvent(reader, pending);
    assert.equal(placement.document.event.event_kind, 'milestone_placed');
    assert.equal(placement.document.event.item_id, firstEvent.document.event.item_id);
    const secondMove = await apiFetch(api, `${path}/moves`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ verb: 'add', args: { lane: 'app', title: 'Live two' } }) });
    assert.equal(secondMove.status, 200);
    const expectedSecond = await secondMove.json();
    const second = await nextSseEvent(reader, pending);
    assert.equal(second.id, String(expectedSecond.event.event_id));
    assert.ok(Number(second.id) > Number(firstEvent.id), 'the reconnect resumed after the delivered event without replay');
    assert.equal(second.document.event.event_kind, 'add');
    assert.notEqual(second.id, firstEvent.id);
  } finally {
    await reader.cancel();
  }
});

test('[A5,A6] doctor diagnoses future event logs read-only and accepts the current marker', async () => {
  const box = project();
  const added = json(box, box.repo, 'add', ['app', 'Version fixture', '--specs', 'G1']);
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  assert.ok(added.item.item_id);
  assert.equal(readEventLogVersion(file), String(EVENT_LOG_VERSION));
  const beforeCurrent = readFileSync(file);
  const current = await runLocal(box, box.repo, 'doctor', '--json');
  assert.equal(current.status, 0, current.stderr || current.stdout);
  assert.equal(current.stderr, '');
  assert.deepEqual(JSON.parse(current.stdout).problems, [], 'the current event-log version is healthy');
  assert.deepEqual(readFileSync(file), beforeCurrent, 'doctor leaves a current board byte-for-byte unchanged');

  setEventLogVersion(file, READABLE_EVENT_LOG + 1);
  const eventsDb = new DatabaseSync(file);
  let events;
  try { events = eventsDb.prepare('SELECT COUNT(*) AS count FROM event').get().count; }
  finally { eventsDb.close(); }
  assert.ok(events > 0, 'the fixture has real events before modeling the future version');
  const futureBytes = readFileSync(file);
  const refused = await runLocal(box, box.repo, 'doctor', '--json');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.equal(refused.stderr, '', 'doctor returns a JSON finding');
  const problems = JSON.parse(refused.stdout).problems;
  const problem = problems.find((entry) => entry.code === 'EVENT_LOG_VERSION');
  assert.ok(problem, refused.stdout);
  assert.match(problem.message, new RegExp(`event log version ${READABLE_EVENT_LOG + 1}.*version ${READABLE_EVENT_LOG}`));
  assert.match(problem.next, /upgrade pullboard/i);
  assert.deepEqual(readFileSync(file), futureBytes, 'the read-only diagnosis preserves the complete board file');
  assert.equal(readEventLogVersion(file), String(READABLE_EVENT_LOG + 1), 'doctor does not silently upgrade the marker');
});

test('[A5] view export preserves the typed future-version refusal without creating output', async () => {
  const box = project();
  const added = json(box, box.repo, 'add', ['app', 'Export version fixture', '--specs', 'G1']);
  const file = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  assert.ok(added.item.item_id);
  setEventLogVersion(file, READABLE_EVENT_LOG + 1);
  const eventsDb = new DatabaseSync(file);
  let events;
  try { events = eventsDb.prepare('SELECT COUNT(*) AS count FROM event').get().count; }
  finally { eventsDb.close(); }
  assert.ok(events > 0, 'the fixture has real events before export refuses');
  const before = readFileSync(file);
  const output = join(box.dir, 'future-version-export');
  assert.equal(existsSync(output), false);

  const refused = await runLocal(box, box.repo, 'view', '--export', output, '--json');
  assert.equal(refused.status, 1, refused.stderr || refused.stdout);
  assert.equal(refused.stderr, '', 'view export returns a JSON refusal');
  const error = JSON.parse(refused.stdout).error;
  assert.equal(error.code, 'EVENT_LOG_VERSION', refused.stdout);
  assert.match(error.message, new RegExp(`event log version ${READABLE_EVENT_LOG + 1}.*version ${READABLE_EVENT_LOG}`));
  assert.match(error.next, /upgrade pullboard/i);
  assert.equal(existsSync(output), false, 'refused export creates no output directory or files');
  assert.deepEqual(readFileSync(file), before, 'refused export preserves every board byte');
  assert.equal(readEventLogVersion(file), String(READABLE_EVENT_LOG + 1));
});

test('one move recomputes only the items it touched [A2,N26]', async (t) => {
  const box = project();
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = openBoard(boardFile, undefined, { isMain: true });
  const ids = [];
  try {
    for (let index = 0; index < 300; index += 1) {
      ids.push(addRoutedItem(board, {
        by: 'coordinator', lane: 'app', title: `Incremental item ${String(index + 1).padStart(3, '0')}`,
        criterion: `Exercise item projection ${index + 1}`, specIds: ['G1'], route: index === 2 ? 'mid' : 'light',
        brief: 'Files:\n- app/incremental-fixture.js\nChange:\n- Preserve the fixture item.\nTest:\n- The API projection matches a full rebuild.',
        check: 'true',
        ...(index === 1 ? { after: [ids[0]] } : {}),
      }));
    }
  } finally {
    closeBoard(board);
  }
  assert.equal(ids.length, 300);

  const builder = json(box, box.repo, 'worktree', ['app', '--route', 'light', '--model', 'fixture-builder']);
  const verifier = json(box, box.repo, 'worktree', ['app', '--route', 'light', '--model', 'fixture-verifier']);
  /** Execute the real CLI with only this test's private homes, Git config and PATH. */
  async function runFixtureCommand(argv, io) {
    const keys = new Set([...Object.keys(box.env), ...AGENT_SHELL_MARKERS, 'PULLBOARD_RELAY_TOKEN', 'npm_config_cache']);
    const previous = new Map([...keys].map((key) => [key, process.env[key]]));
    try {
      for (const key of keys) {
        if (Object.hasOwn(box.env, key)) process.env[key] = box.env[key];
        else delete process.env[key];
      }
      process.env.npm_config_cache = join(box.dir, 'npm-cache');
      return await main(argv, io);
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }
  const realDateNow = Date.now.bind(Date);
  const realWallStart = realDateNow();
  let clockOffsetMs = 0;
  t.mock.timers.enable({ apis: ['Date'], now: realWallStart });
  /** Preserve real elapsed wall time while allowing an explicit offset for eventless expiry. */
  function setTestClock() {
    t.mock.timers.setTime(realWallStart + (realDateNow() - realWallStart) + clockOffsetMs);
  }
  setTestClock();
  const builds = [];
  let stateBuilds = 0;
  const api = await startLocalHandler(t, box, {
    runCommand: runFixtureCommand,
    personChannel: 'api', stateDetail: 'full',
    onStateBuild: () => { stateBuilds += 1; },
    onItemBuild: (entry) => builds.push(entry.itemId),
  });
  const boardListing = await apiFetch(api, '/api/v1/boards');
  assert.equal(boardListing.status, 200);
  const boardId = (await boardListing.json()).boards.find((entry) => entry.root === box.repo).id;
  const path = `/api/v1/boards/${boardId}`;

  /** Send one authenticated local API move and return its versioned response. */
  async function move(verb, item, args = {}, agent = 'coordinator') {
    setTestClock();
    const response = await apiFetch(api, `${path}/moves`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verb, ...(item === undefined ? {} : { item }), args, agent }),
    });
    const document = await response.json();
    assert.equal(response.status, 200, `${verb} move: ${JSON.stringify(document)}`);
    return document;
  }

  /** Compare the live cached handler's full state with a newly constructed full projection. */
  async function assertFreshFullState(label) {
    setTestClock();
    const comparisonTime = Date.now();
    const currentResponse = await apiFetch(api, `${path}/state?detail=full`);
    assert.equal(currentResponse.status, 200, `${label}: live state response`);
    const current = await currentResponse.json();
    const fresh = await startLocalHandler(t, box, { personChannel: 'api', stateDetail: 'full' });
    try {
      const freshResponse = await apiFetch(fresh, `${path}/state?detail=full`);
      assert.equal(freshResponse.status, 200, `${label}: fresh full state response`);
      const freshState = (await freshResponse.json()).state, diff = (a, b, p = '$', out = []) => { if (JSON.stringify(a) === JSON.stringify(b)) return out; if (a && b && typeof a === 'object' && typeof b === 'object') for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], `${p}.${k}`, out); else out.push([p, a, b]); return out; }; assert.deepEqual(current.state, freshState, `${label}: incremental state equals a clean full rebuild; differing paths: ${JSON.stringify(diff(current.state, freshState).slice(0, 20))}`);
      assert.equal(Date.now(), comparisonTime, `${label}: both state projections use the same controlled instant`);
    } finally {
      await fresh.close();
    }
    return current.state;
  }

  /** Read one item's current lease from the fixture board without changing its event cursor. */
  function leaseUntil(itemId) {
    const current = openBoard(boardFile, undefined, { isMain: true });
    try { return current.db.prepare('SELECT item_lease_until FROM item WHERE item_id = ?').get(itemId).item_lease_until; }
    finally { closeBoard(current); }
  }

  try {
    const initialResponse = await apiFetch(api, `${path}/state?detail=full`);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.equal(initial.state.items.length, 300);
    assert.equal(builds.length, 300, 'the initial full snapshot projects each item once');
    assert.equal(stateBuilds, 1);

    builds.length = 0;
    await move('edit', ids[2], { criterion: 'One item changed after the warm snapshot' });
    const edited = await assertFreshFullState('single item edit');
    assert.deepEqual(builds, [ids[2]], 'one item move rebuilds only its touched item');
    assert.equal(edited.items.find((item) => item.id === ids[2]).criterion, 'One item changed after the warm snapshot');

    builds.length = 0;
    await move('claim', ids[0], {}, builder.agent);
    commitWork(box, builder, ids[0]); await move('submit', ids[0], {}, builder.agent);
    checkOutSubmitted(box, builder, verifier); await move('next', undefined, { verify: true }, verifier.agent);
    // Keep the fixture's trunk fixed so automatic landing cannot invalidate every item during this incremental check.
    writeFileSync(join(box.repo, 'landing-fixture-dirty'), 'hold the trunk\n');
    await move('verify', ids[0], { decision: 'accept', reason: 'CRITERION_MET', note: 'verified dependency' }, verifier.agent);
    builds.length = 0;
    const dependencyState = await assertFreshFullState('verified dependency');
    assert.deepEqual(builds, [ids[0], ids[1], ids[3]], 'the verified item, its dependent and the next light item a seat claimed on submit are recomputed');
    assert.deepEqual(dependencyState.items.find((item) => item.id === ids[1]).blockedBy, [],
      'the waiting item becomes unblocked when its dependency is verified');
    for (const extra of dependencyState.items.filter((item) => [ids[1], ids[3]].includes(item.id) && item.claim)) {
      assert.ok([builder.agent, verifier.agent].includes(extra.claim.by), 'the extra claim belongs to a fixture seat');
      const owner = extra.claim.by === builder.agent ? builder : verifier;
      const released = await runLocal(box, owner.path, 'release', String(extra.id), '--reason', 'OTHER', '--note', 'isolate the later lease expiry', '--no-next');
      assert.equal(released.status, 0, released.stderr || released.stdout);
    }
    await assertFreshFullState('release the extra claims');

    builds.length = 0;
    await move('shout', undefined, { to: 'all', text: 'Board-only change for incremental projection' });
    const shouted = await assertFreshFullState('board-only shout');
    assert.deepEqual(builds, [], 'an event with no item_id recomputes zero item bodies');
    assert.ok(shouted.shouts.some((entry) => entry.shout_text === 'Board-only change for incremental projection'));

    const detailBuilds = [];
    let detailStateBuilds = 0;
    const detailOnly = await startLocalHandler(t, box, {
      personChannel: 'api', stateDetail: 'full',
      onStateBuild: () => { detailStateBuilds += 1; },
      onItemBuild: (entry) => detailBuilds.push(entry.itemId),
    });
    try {
      const detailResponse = await apiFetch(detailOnly, `${path}/items/${ids[17]}`);
      assert.equal(detailResponse.status, 200);
      assert.equal((await detailResponse.json()).item.id, ids[17]);
      assert.deepEqual(detailBuilds, [ids[17]], 'a cold item detail projects only its requested item');
      assert.equal(detailStateBuilds, 0, 'a cold item detail does not build or queue behind a full board snapshot');
    } finally {
      await detailOnly.close();
    }

    builds.length = 0;
    const specFile = join(box.repo, 'SPEC.md');
    writeFileSync(specFile, SPEC.replace('The fixture keeps its board.', 'The fixture keeps its changed specification.'));
    await assertFreshFullState('SPEC.md change');

    builds.length = 0;
    const configFile = join(box.repo, 'pullboard.json');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    config.agents.names = 'prefix';
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
    await assertFreshFullState('pullboard.json change');

    builds.length = 0;
    const milestone = await runLocal(box, box.repo, 'milestone', 'add', 'Incremental milestone', '--reason', 'Arrange fixture release', '--items', String(ids[4]));
    assert.equal(milestone.status, 0, milestone.stderr || milestone.stdout);
    const milestoneState = await assertFreshFullState('milestone change');
    assert.deepEqual(builds, [ids[4]], 'changing one milestone membership recomputes only the affected item');
    assert.equal(milestoneState.items.find((item) => item.id === ids[4]).milestone, 'Incremental milestone');

    builds.length = 0;
    await move('claim', ids[299], {}, builder.agent);
    const claimed = await assertFreshFullState('claim before lease expiry');
    assert.equal(claimed.items.find((item) => item.id === ids[299]).status, 'claimed');
    const lease = leaseUntil(ids[299]);
    const sequenceBeforeExpiry = claimed.sequence;
    clockOffsetMs += Date.parse(lease) - Date.now() + 1;
    setTestClock();
    builds.length = 0;
    const expired = await assertFreshFullState('eventless claim lease expiry');
    assert.equal(leaseUntil(ids[299]), lease, 'advancing the test clock leaves the persisted lease deadline unchanged');
    assert.equal(expired.sequence, sequenceBeforeExpiry, 'lease expiry appends no board event');
    assert.equal(expired.items.find((item) => item.id === ids[299]).status, 'open');
    assert.deepEqual(builds, [ids[299]], 'eventless lease expiry recomputes only the expired claim');

    const queryBoard = openBoard(boardFile, undefined, { isMain: true });
    try {
      const queries = [];
      const trackedBoard = { ...queryBoard, db: {
        prepare(sql) {
          const statement = queryBoard.db.prepare(sql);
          return { all(...params) { queries.push({ sql, params }); return statement.all(...params); } };
        },
      } };
      boardEvents(trackedBoard, { itemId: ids[17] });
      verdictsFor(trackedBoard, ids[17]);
      const itemQueries = queries.filter(({ sql }) => /\bFROM\s+(?:event|verdict)\b/iu.test(sql));
      assert.ok(itemQueries.some(({ sql }) => /FROM\s+event\s+WHERE\s+item_id\s*=\s*\?/iu.test(sql)),
        'the production item-events query binds item_id directly');
      assert.ok(itemQueries.some(({ sql }) => /FROM\s+verdict\s+WHERE\s+item_id\s*=\s*\?/iu.test(sql)),
        'the production verdict query binds item_id directly');
      assert.ok(!itemQueries.some(({ sql }) => /\?\s+IS\s+NULL\s+OR\s+item_id/iu.test(sql)),
        'the production item-events query has no index-blocking optional-filter form');
      for (const { sql, params } of itemQueries) {
        const plan = queryBoard.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(({ detail }) => detail).join('\n');
        if (/\bFROM\s+event\b/iu.test(sql)) {
          assert.match(plan, /SEARCH\s+event\s+USING\s+(?:COVERING\s+)?INDEX\s+event_item_id_event_id/iu,
            `item event query uses its item_id index:\n${sql}\n${plan}`);
        } else {
          assert.match(plan, /SEARCH\s+verdict\s+USING\s+(?:COVERING\s+)?INDEX\s+verdict_item_id_verdict_id/iu,
            `item verdict query uses its item_id index:\n${sql}\n${plan}`);
        }
        assert.doesNotMatch(plan, /SCAN\s+(?:event|verdict)\b/iu, `item query has no full-table scan:\n${sql}\n${plan}`);
      }
      assert.ok(itemQueries.some(({ sql }) => /FROM\s+event\s+WHERE\s+item_id\s*=\s*\?.*event_kind/isu.test(sql)),
        "verdict receipts are read from the item's event rows");
      assert.ok(itemQueries.some(({ sql, params }) => /FROM\s+event\s+WHERE\s+item_id\s*=\s*\?/iu.test(sql)
        && params.length === 1 && params[0] === ids[17]), 'the production scoped event query binds the requested item id');
      assert.ok(itemQueries.some(({ sql, params }) => /FROM\s+verdict\s+WHERE\s+item_id\s*=\s*\?/iu.test(sql)
        && params.length === 1 && params[0] === ids[17]), 'the production scoped verdict query binds the requested item id');
      const indexes = queryBoard.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(({ name }) => name);
      assert.ok(indexes.includes('event_item_id_event_id'));
      assert.ok(indexes.includes('verdict_item_id_verdict_id'));
    } finally {
      closeBoard(queryBoard);
    }

    await api.close();
    const legacy = new DatabaseSync(boardFile);
    // A board from before these indexes carries an older user_version; only that makes an open migrate (#1047).
    try { legacy.exec('DROP INDEX event_item_id_event_id; DROP INDEX verdict_item_id_verdict_id; PRAGMA user_version = 1;'); }
    finally { legacy.close(); }
    // This positive migration control uses a private database; branch code cannot repair
    // persistent indexes on the repository-shared board by supplying isMain: true.
    const privateLegacy = join(box.dir, 'index-migration.sqlite');
    cpSync(boardFile, privateLegacy);
    const migrated = openBoard(privateLegacy);
    try {
      const restored = migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map(({ name }) => name);
      assert.ok(restored.includes('event_item_id_event_id'), 'reopening an existing board restores the event item index');
      assert.ok(restored.includes('verdict_item_id_verdict_id'), 'reopening an existing board restores the verdict item index');
    } finally {
      closeBoard(migrated);
    }
  } finally {
    await api.close();
  }
});

/** An agent writing to the board from its own process until the stop file appears, then printing its write count. */
const WRITER = `import { DatabaseSync } from 'node:sqlite'; import { existsSync } from 'node:fs';
const [file, stop] = process.argv.slice(1); const db = new DatabaseSync(file); db.exec('PRAGMA busy_timeout = 5000');
const insert = db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', 'edit', ?, '{}')");
let n = 0; process.stdout.write('ready\\n');
while (!existsSync(stop)) { db.exec('BEGIN IMMEDIATE'); insert.run(new Date().toISOString(), 1 + (n++ % 1000)); db.exec('COMMIT'); await new Promise((done) => setTimeout(done, 2)); }
db.close(); process.stdout.write(n + '\\n');`;

test('[N26,A2] an item detail answers under 20 ms on a large board', async (t) => {
  const box = project();
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = openBoard(boardFile, undefined, { isMain: true });
  const ids = [];
  try {
    for (let index = 0; index < 1000; index += 1) ids.push(addRoutedItem(board, { by: 'coordinator', lane: 'app', title: `Large item ${index + 1}`,
      criterion: `Detail ${index + 1}`, specIds: ['G1'], route: 'light', brief: 'Files:\n- app/large.js\nChange:\n- Keep it.\nTest:\n- It reads fast.', check: 'true' }));
    const insert = board.db.prepare("INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, 'coordinator', 'edit', ?, '{}')");
    board.db.exec('BEGIN'); // One transaction seeds the remaining events up to 40,000.
    for (let event = board.db.prepare('SELECT COUNT(*) AS n FROM event').get().n; event < 40_000; event += 1) insert.run(new Date(Date.UTC(2026, 0, 1, 0, 0, event)).toISOString(), ids[event % 1000]);
    board.db.exec('COMMIT');
  } finally { closeBoard(board); }
  const builds = [];
  const api = await startLocalHandler(t, box, { personChannel: 'api', stateDetail: 'summary', onItemBuild: (entry) => builds.push(entry.itemId) });
  const path = `/api/v1/boards/${(await (await apiFetch(api, '/api/v1/boards')).json()).boards[0].id}`;
  const polled = await apiFetch(api, `${path}/state`);
  assert.equal((await polled.json()).state.items.length, 1000);
  const unchanged = await apiFetch(api, `${path}/state`, { headers: { 'if-none-match': polled.headers.get('etag') } });
  assert.equal(unchanged.status, 304, 'an unchanged state poll gets a not-modified reply');
  assert.equal(await unchanged.text(), '');
  const stop = join(box.dir, 'stop-writer');
  const writer = spawn(process.execPath, ['--input-type=module', '-e', WRITER, boardFile, stop], { stdio: ['ignore', 'pipe', 'pipe'] });
  let written = ''; writer.stdout.on('data', (part) => { written += part; });
  while (!written.includes('ready')) await new Promise((done) => setTimeout(done, 5));
  const times = [];
  try {
    for (const id of ids.slice(0, 20)) times.push(await timedMs(async () => assert.equal((await (await apiFetch(api, `${path}/items/${id}`)).json()).item.id, id)));
  } finally { writeFileSync(stop, ''); await once(writer, 'close'); }
  assert.ok(Number(written.split('\n')[1]) > 0, 'an agent wrote to the board while the details were read');
  const sorted = [...times].sort((left, right) => left - right), median = (sorted[9] + sorted[10]) / 2;
  const report = `item detail ms, median ${median.toFixed(1)}: ${times.map((ms) => ms.toFixed(1)).join(' ')}`; t.diagnostic(report);
  assert.ok(median < 20 && sorted[19] < 50, report); // budget: declared by approved row N26 item #1040: median under 20 ms, none over 50 ms
  await (await apiFetch(api, `${path}/items/${ids[19]}`)).json();
  builds.length = 0;
  assert.equal((await (await apiFetch(api, `${path}/items/${ids[19]}`)).json()).item.id, ids[19]);
  assert.deepEqual(builds, [], 'an item whose last event has not moved is served from its cached detail');
});
