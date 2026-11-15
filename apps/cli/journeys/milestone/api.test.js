import { viewApiPorts } from '../../../view/index.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import { openBoard } from '../../../lib/index.js';
import { copyPackageFiles } from '../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runFixtureChild as spawnSync } from '../../tests/fixtures/child.js';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { main } from '../../tests/fixtures/native.js';
import { createLocalApiHandler } from '../../../../packages/api/index.js';
import { refusalDocument } from '../../index.js';
import { serveApi } from '../../../../packages/api/index.js';
import * as apiExports from '../../../../packages/api/index.js';
import { EVENT_LOG_VERSION } from '../../../../packages/store/index.js';
import { SIGNED_EVENT_LOG_VERSION } from '../../../../packages/store/index.js';
import { apiError } from '../../tests/fixtures/api.js';
import { apiFetch } from '../../tests/fixtures/api.js';
import { json } from '../../tests/fixtures/api/project.js';
import { project } from '../../tests/fixtures/api/project.js';
import { readEventLogVersion } from '../../tests/fixtures/api/project.js';
import { setEventLogVersion } from '../../tests/fixtures/api/project.js';
import { runLocal } from '../../tests/fixtures/api/milestone.js';
import { startLocalHandler } from '../../tests/fixtures/api/milestone.js';

// The newest event-log format this Pullboard reads: a board with signed person moves is format 2 [E22].
const READABLE_EVENT_LOG = Math.max(EVENT_LOG_VERSION, SIGNED_EVENT_LOG_VERSION);
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
  assert.deepEqual({ version: 1, ...apiBoardListing(projects, undefined, refusalDocument, apiBoardOpeners, typeof viewApiPorts.projectSummary === 'function') }, listed);
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
  const api = await startLocalHandler(t, box);
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

