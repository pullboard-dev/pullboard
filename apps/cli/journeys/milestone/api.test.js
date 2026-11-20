import { viewApiPorts } from '../../../view/index.js';
import { apiBoardOpeners } from '../../tests/fixtures/board.js';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { main } from '../../tests/fixtures/native.js';
import { refusalDocument } from '../../index.js';
import { serveApi } from '../../../../packages/api/index.js';
import * as apiExports from '../../../../packages/api/index.js';
import { EVENT_LOG_VERSION } from '../../../../packages/store/index.js';
import { apiFetch } from '../../tests/fixtures/api.js';
import { json } from '../../tests/fixtures/api/project.js';
import { project } from '../../tests/fixtures/api/project.js';
import { runLocal } from '../../tests/fixtures/api/milestone.js';
import { startLocalHandler } from '../../tests/fixtures/api/milestone.js';

test('cli.journeys-milestone-api.apiboardlisting-is-exported-and-matches-the: apiBoardListing is exported and matches the board list [A2]', async (t) => {
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
test('cli.journeys-milestone-api.append-only-event-records-expose-format: [A5] append-only event records expose format version one', () => {
  assert.equal(EVENT_LOG_VERSION, 1);
});
test('cli.journeys-milestone-api.authenticated-api-state-exposes-model-labels: [O8] authenticated API state exposes model labels and configured stable display names', async (t) => {
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