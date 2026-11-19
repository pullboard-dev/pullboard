/** Every remaining board API handler runs in the worker pool, and a read never falls back to the request thread [A2,C7]. */
import assert from 'node:assert/strict';
import { BroadcastChannel } from 'node:worker_threads';
import { test } from 'node:test';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { closeCellBoard } from '../../../../board/tests/fixtures/cell-board.js';
import { boardId } from '../../../../store/index.js';
import { openBoardForRead } from '../../../../store/index.js';
import { serveApi } from '../../../index.js';

const SECRET = 'fixture-secret';
const CELL = new URL('../../../../board/tests/fixtures/cell-board.js', import.meta.url).href;
const STORE = new URL('../../../../store/index.js', import.meta.url).href;
const API = new URL('../../../index.js', import.meta.url).href;
const VIEW_PORTS = Object.freeze(Object.fromEntries(['projectState', 'activeViewAgents', 'viewProofSummary', 'compactItemSummaries', 'viewFlowSummary']
  .map((name) => [name, () => { throw new Error(`these tests do not project ${name}`); }])));

/** The renderer the API takes as a port: a refusal becomes its public error body. */
function refusalDocument(error) { return { error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }; }

/** A ports module (a data: URL) whose handler of each kind in `blocked` tells the channel and then busy-waits 30 s. */
function ports(blocked = [], channel = 'unused') {
  const hooks = blocked.map((kind) => `${kind}() {
    const channel = new BroadcastChannel(${JSON.stringify(channel)});
    channel.postMessage(${JSON.stringify(kind)});
    channel.close();
    const until = Date.now() + 30000;
    while (Date.now() < until) { /* The test hook busy-waits inside the handler. */ }
    return { ok: true };
  },`).join('\n');
  const source = `import { BroadcastChannel } from 'node:worker_threads';
import { openCellBoard } from ${JSON.stringify(CELL)};
import { openBoardForRead } from ${JSON.stringify(STORE)};
import { poolHandlers } from ${JSON.stringify(API)};
export function boardHandlerPorts({ isMain }) {
  return { handlers: { ...poolHandlers({ boardOpeners: { openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] } }, { isMain, runCommand: async () => 0, refusalDocument: (e) => ({ error: { code: e.code } }) }), ${hooks} } };
}`;
  return 'data:text/javascript,' + encodeURIComponent(source);
}

/** Serve one fixture board; returns the API and the board's id. */
async function served(t, handlerPorts, options = {}) {
  const project = cellProject(t, { real: true });
  const board = openCellBoard(project.boardFile);
  let id;
  try { id = boardId(board); } finally { closeCellBoard(board); }
  const entry = { root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-12' };
  const api = await serveApi({ projects: () => [entry], secret: SECRET, runCommand: async () => 0, isMain: false, refusalDocument,
    boardOpeners: { openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] }, viewPorts: VIEW_PORTS, handlerPorts, ...options });
  t.after(() => api.close());
  return { api, id };
}

/** A request with the key; the signal lets a test drop a call that never answers. */
function call(api, path, { body, signal } = {}) {
  return fetch(`http://127.0.0.1:${api.port}${path}`, { method: body ? 'POST' : 'GET', signal,
    headers: { 'x-pullboard-key': SECRET, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

/** Health's answer time and status. */
async function timedHealth(api) {
  const started = performance.now();
  const response = await call(api, '/api/v1/health');
  await response.json();
  return { ms: performance.now() - started, status: response.status };
}

test('api.pool-reads.clause-events-moves-requests-handler: clause 2 [A2,C7]: with an events, moves or requests handler blocked for 30 s in a pool worker, health answers within 200 ms', { timeout: 60_000 }, async (t) => {
  const channel = `reads-blocked-${process.pid}`;
  const listener = new BroadcastChannel(channel);
  t.after(() => listener.close());
  const heard = new Set();
  const all = new Promise((resolve) => { listener.onmessage = (event) => { heard.add(event.data); if (heard.size === 3) resolve(); }; });
  const { api, id } = await served(t, ports(['events', 'move', 'request'], channel));
  await timedHealth(api); // The first request pays for the connection.
  const abort = new AbortController();
  t.after(() => abort.abort());
  const { signal } = abort;
  call(api, `/api/v1/boards/${id}/events?after=0`, { signal }).catch(() => {});
  call(api, `/api/v1/boards/${id}/moves`, { body: { verb: 'next' }, signal }).catch(() => {});
  call(api, `/api/v1/boards/${id}/requests`, { body: { text: 'hello' }, signal }).catch(() => {});
  await all;
  const health = await timedHealth(api);
  assert.equal(health.status, 200);
  assert.ok(health.ms < 200, `health took ${health.ms.toFixed(1)} ms with an events, a move and a request handler blocked`);
});

test('api.pool-reads.clause-board-lookup-api-boards: clause 3 [A2,C7]: the board lookup for a /api/v1/boards/:id route runs in a pool worker, so a blocked lookup leaves health answering within 200 ms', { timeout: 60_000 }, async (t) => {
  const channel = `reads-board-${process.pid}`;
  const listener = new BroadcastChannel(channel);
  t.after(() => listener.close());
  const blocked = new Promise((resolve) => { listener.onmessage = () => resolve(); });
  const { api, id } = await served(t, ports(['board'], channel));
  await timedHealth(api);
  const abort = new AbortController();
  t.after(() => abort.abort());
  call(api, `/api/v1/boards/${id}/events`, { signal: abort.signal }).catch(() => {});
  await blocked;
  const health = await timedHealth(api);
  assert.equal(health.status, 200);
  assert.ok(health.ms < 200, `health took ${health.ms.toFixed(1)} ms with the board lookup blocked`);
});

test('api.pool-reads.clause-item-detail-read-runs: clause 1 [A2,C7]: the item detail read runs in a pool worker, so a detail handler blocked 30 s leaves health answering within 200 ms', { timeout: 60_000 }, async (t) => {
  const channel = `reads-item-${process.pid}`;
  const listener = new BroadcastChannel(channel);
  t.after(() => listener.close());
  const blocked = new Promise((resolve) => { listener.onmessage = () => resolve(); });
  const { api, id } = await served(t, ports(['item'], channel));
  await timedHealth(api);
  const abort = new AbortController();
  t.after(() => abort.abort());
  call(api, `/api/v1/boards/${id}/items/1`, { signal: abort.signal }).catch(() => {});
  await blocked;
  const health = await timedHealth(api);
  assert.equal(health.status, 200);
  assert.ok(health.ms < 200, `health took ${health.ms.toFixed(1)} ms with the item detail handler blocked`);
});

test('api.pool-reads.clause-item-detail-read-answers: clause 1 [A2,C7]: an item detail read answers from the pool worker with the item the board holds', { timeout: 60_000 }, async (t) => {
  const project = cellProject(t, { real: true });
  const board = openCellBoard(project.boardFile);
  let id, filed;
  try { id = boardId(board); filed = cellItem(board, { lane: 'core', title: 'Pooled detail', criterion: '1. It reads [test]' }); } finally { closeCellBoard(board); }
  const entry = { root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-12' };
  const api = await serveApi({ projects: () => [entry], secret: SECRET, runCommand: async () => 0, isMain: false, refusalDocument,
    boardOpeners: { openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] }, viewPorts: VIEW_PORTS, handlerPorts: ports() });
  t.after(() => api.close());
  const response = await call(api, `/api/v1/boards/${id}/items/${filed.item_id}`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.item.id, filed.item_id);
});

test('api.pool-reads.clause-state-worker-stopped-state: clause 1 [A2,C7]: with the state worker stopped, a state read is refused STATE_WORKER_STOPPED, never built on the request thread', { timeout: 60_000 }, async (t) => {
  const crashing = 'data:text/javascript,' + encodeURIComponent('export async function boardStatePorts() { throw new Error("fixture: the state worker dies at start"); }');
  const stopped = Promise.withResolvers();
  t.mock.method(process.stderr, 'write', (text) => { if (String(text).includes('the state worker stopped')) stopped.resolve(); return true; });
  const { api, id } = await served(t, ports(), { statePorts: crashing });
  await stopped.promise;
  const response = await call(api, `/api/v1/boards/${id}/state`);
  const body = await response.json();
  assert.equal(body?.error?.code, 'STATE_WORKER_STOPPED', JSON.stringify(body));
});
