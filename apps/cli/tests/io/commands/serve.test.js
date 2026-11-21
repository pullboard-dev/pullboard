/** The serve's health answers not-ok with API_WORKER_FAILED once its handler workers keep dying, and ok while they answer [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serveApi } from '../../../../../packages/api/index.js';

const SECRET = 'fixture-secret';

/** Handler ports whose module cannot load, so every worker dies at start as they did with a deleted cwd. */
const BROKEN_PORTS = 'data:text/javascript,' + encodeURIComponent("throw new Error('ENOENT: uv_cwd');");
/** Handler ports that give no handlers, so each worker starts and stays up. */
const HEALTHY_PORTS = 'data:text/javascript,' + encodeURIComponent('export function boardHandlerPorts() { return { handlers: {} }; }');
const refusalDocument = (error) => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } });

/** Serve the API with the given handler ports and no boards. */
async function served(t, handlerPorts) {
  const api = await serveApi({ projects: () => [], secret: SECRET, runCommand: async () => 0, isMain: false, refusalDocument, boardOpeners: {}, viewPorts: {}, handlerPorts });
  t.after(() => api.close());
  return api;
}

/** The health answer: its status and body. */
async function health(api) {
  const response = await fetch(`http://127.0.0.1:${api.port}/api/v1/health`, { headers: { 'x-pullboard-key': SECRET } });
  return { status: response.status, body: await response.json() };
}

test('clause 1: after repeated worker start failures the serve health answers not-ok with API_WORKER_FAILED [C7]', { timeout: 30_000 }, async (t) => {
  const api = await served(t, BROKEN_PORTS);
  const deadline = Date.now() + 20_000;
  let answer = await health(api);
  while (answer.body.ok !== false && Date.now() < deadline) {
    answer = await health(api);
  }
  assert.equal(answer.status, 503, JSON.stringify(answer.body));
  assert.equal(answer.body.ok, false);
  assert.equal(answer.body.error.code, 'API_WORKER_FAILED');
});

test('clause 2: the health body carries the failure streak a keeper reads, and a pool whose workers start answers ok [C7]', { timeout: 30_000 }, async (t) => {
  const healthy = await health(await served(t, HEALTHY_PORTS));
  assert.equal(healthy.status, 200, JSON.stringify(healthy.body));
  assert.equal(healthy.body.ok, true);
  assert.equal(healthy.body.pool.lostInARow, 0);
  const broken = await served(t, BROKEN_PORTS);
  let answer = await health(broken);
  const deadline = Date.now() + 20_000;
  while (answer.body.ok !== false && Date.now() < deadline) {
    answer = await health(broken);
  }
  assert.ok(answer.body.pool.lostInARow >= 10, JSON.stringify(answer.body.pool));
  assert.equal(answer.body.pool.ok, false);
  assert.equal(answer.body.pool.error.code, 'API_WORKER_FAILED');
});
