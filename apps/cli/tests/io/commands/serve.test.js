/** The serve keeps its cwd anchored, its restart child uses the checkout root, and health reports dead workers [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { apiFetch } from '../../fixtures/api.js';
import { project } from '../../fixtures/api/project.js';
import { startServeProcess } from '../../fixtures/serve-process.js';
import { serveRestartOptions } from '../../../src/io/commands/serve.js';
import { serveApi } from '../../../../../packages/api/index.js';
import { openCellBoard } from '../../../../../packages/board/tests/fixtures/cell-board.js';
import { openBoardForRead } from '../../../../../packages/store/index.js';

const API_MS = 30_000;
const SECRET = 'fixture-secret';
/** Handler ports whose module cannot load, so every worker dies at start as they did with a deleted cwd. */
const BROKEN_PORTS = 'data:text/javascript,' + encodeURIComponent("throw new Error('ENOENT: uv_cwd');");
/** Handler ports that give no handlers, so each worker starts and stays up. */
const HEALTHY_PORTS = 'data:text/javascript,' + encodeURIComponent('export function boardHandlerPorts() { return { handlers: {} }; }');
/** View projections the handler requires at construction; these tests never project state. */
const VIEW_PORTS = Object.freeze(Object.fromEntries(['projectState', 'activeViewAgents', 'viewProofSummary', 'compactItemSummaries', 'viewFlowSummary']
  .map((name) => [name, () => { throw new Error(`these tests do not project ${name}`); }])));
const refusalDocument = (error) => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } });

/** Serve the API with the given handler ports and no boards. */
async function served(t, handlerPorts) {
  const api = await serveApi({ projects: () => [], secret: SECRET, runCommand: async () => 0, isMain: false, refusalDocument, boardOpeners: { openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] }, viewPorts: VIEW_PORTS, handlerPorts });
  t.after(() => api.close());
  return api;
}

/** The health answer: its status and body. */
async function health(api) {
  const response = await fetch(`http://127.0.0.1:${api.port}/api/v1/health`, { headers: { 'x-pullboard-key': SECRET } });
  return { status: response.status, body: await response.json() };
}

test('cli.io-commands-serve.repo-root-cwd.relaunch-options-pin-checkout: clause 2: both serve restart paths pass the served board primary root as cwd [C7]', () => {
  const box = project();
  const codeRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  assert.notEqual(box.repo, codeRoot, 'the served fixture repository differs from the CLI code installation root');
  assert.deepEqual(serveRestartOptions(123, '/tmp/serve.log', box.repo), { fd: 123, cwd: box.repo, log: '/tmp/serve.log' });
  assert.deepEqual(serveRestartOptions(null, '/tmp/serve.log', box.repo), { cwd: box.repo, log: '/tmp/serve.log' });
});

test('cli.io-commands-serve.health-reports-worker-failure: clause 1: after repeated worker start failures the serve health answers not-ok with API_WORKER_FAILED [C7]', { timeout: API_MS }, async (t) => {
  const api = await served(t, BROKEN_PORTS);
  const deadline = Date.now() + 20_000;
  let answer = await health(api);
  while (answer.body.ok !== false && Date.now() < deadline) answer = await health(api);
  assert.equal(answer.status, 503, JSON.stringify(answer.body));
  assert.equal(answer.body.ok, false);
  assert.equal(answer.body.error.code, 'API_WORKER_FAILED');
});

test('cli.io-commands-serve.repo-root-cwd.deleted-launch-folder-still-claims: clauses 1 and 3: native serve pins its cwd before handler threads inherit it and answers a runner claim after launch cwd removal [C7]', async t => {
  const box = project();
  const codeRoot = fileURLToPath(new URL('../../../../../', import.meta.url));
  assert.notEqual(box.repo, codeRoot, 'the native CLI serves a repository outside its code installation root');
  const launch = join(box.repo, 'serve-launch-cwd');
  mkdirSync(launch);
  const running = await startServeProcess(launch, box.env, API_MS);
  t.after(() => running.stop());
  rmSync(launch, { recursive: true, force: true });
  try {
    const listingUrl = new URL(running.server.url);
    const api = { origin: listingUrl.origin, secret: listingUrl.searchParams.get('k') };
    assert.ok(api.secret, 'serve prints the local API key');
    const boards = await (await apiFetch(api, '/api/v1/boards')).json();
    const listedBoards = boards.boards ?? boards;
    const id = listedBoards[0]?.id;
    assert.equal(listedBoards.length, 1, `serve keeps the one board from its launch repository: ${JSON.stringify(boards)}`);
    assert.ok(id, `serve lists its fixture board: ${JSON.stringify(boards)}`);
    const response = await apiFetch(api, `/api/v1/boards/${id}/jobs`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'claim', runner: 'cwd-removed-fixture', capabilities: [] }),
    });
    const document = await response.json();
    assert.equal(response.status, 200, JSON.stringify(document));
    assert.ok(Object.hasOwn(document, 'claim'), 'the API worker answered the runner claim');
  } finally {
    await running.stop();
  }
});

test('cli.io-commands-serve.health-keeps-healthy-pool-ok: clause 2: healthy pool health stays ok and reports the failure streak once dead workers keep failing [C7]', { timeout: API_MS }, async (t) => {
  const healthy = await health(await served(t, HEALTHY_PORTS));
  assert.equal(healthy.status, 200, JSON.stringify(healthy.body));
  assert.equal(healthy.body.ok, true);
  assert.equal(healthy.body.pool.lostInARow, 0);
  const broken = await served(t, BROKEN_PORTS);
  let answer = await health(broken);
  const deadline = Date.now() + 20_000;
  while (answer.body.ok !== false && Date.now() < deadline) answer = await health(broken);
  assert.ok(answer.body.pool.lostInARow >= 10, JSON.stringify(answer.body.pool));
  assert.equal(answer.body.pool.ok, false);
  assert.equal(answer.body.pool.error.code, 'API_WORKER_FAILED');
});
