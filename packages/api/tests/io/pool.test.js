/** The board API's request thread never blocks: handlers run in a worker pool, health always answers, a full pool refuses by name, and a stall is recorded [A2,C7]. */
import assert from 'node:assert/strict';
import { BroadcastChannel } from 'node:worker_threads';
import { test } from 'node:test';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { closeCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { boardId } from '../../../store/index.js';
import { openBoardForRead } from '../../../store/index.js';
import { serveApi } from '../../index.js';
import { startLoopWatchdog } from '../../../drive/index.js';

const SECRET = 'fixture-secret';
const CELL = new URL('../../../board/tests/fixtures/cell-board.js', import.meta.url).href;
const STORE = new URL('../../../store/index.js', import.meta.url).href;
const API = new URL('../../index.js', import.meta.url).href;

/** The renderer the API takes as a port: a refusal becomes its public error body. */
function refusalDocument(error) {
  return { error: { code: error.code ?? 'INTERNAL', message: String(error.message) } };
}

/** View projections the handler requires at construction; these tests never project state. */
const VIEW_PORTS = Object.freeze(Object.fromEntries(['projectState', 'activeViewAgents', 'viewProofSummary', 'compactItemSummaries', 'viewFlowSummary']
  .map((name) => [name, () => { throw new Error(`these tests do not project ${name}`); }])));

/**
 * A handler ports module, as a data: URL, giving the API's pool handlers over the fixture board's openers. With
 * `channel`, its jobs handler is the test hook: it tells the channel it is blocked and then busy-waits `blockMs` inside the handler.
 */
function handlerPorts({ channel = null, blockMs = 30_000, fail = false } = {}) {
  const hook = channel === null ? '' : `jobs() {
    const channel = new BroadcastChannel(${JSON.stringify(channel)});
    channel.postMessage('blocked');
    channel.close();
    const until = Date.now() + ${blockMs};
    while (Date.now() < until) { /* The test hook busy-waits inside the handler. */ }
    ${fail ? "throw new Error('fixture handler failed');" : 'return { ok: true };'}
  },`;
  const source = `import { BroadcastChannel } from 'node:worker_threads';
import { openCellBoard } from ${JSON.stringify(CELL)};
import { openBoardForRead } from ${JSON.stringify(STORE)};
import { poolHandlers } from ${JSON.stringify(API)};
export function boardHandlerPorts({ isMain }) {
  return { handlers: { ...poolHandlers({ boardOpeners: { openBoard: openCellBoard, openBoardForRead } }, { isMain }), ${hook} } };
}
`;
  return 'data:text/javascript,' + encodeURIComponent(source);
}

/** A fixture project's registry entry and its board's persistent id. */
function fixtureBoard(t) {
  const project = cellProject(t, { real: true });
  const board = openCellBoard(project.boardFile);
  try { return { project, entry: { root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-12' }, id: boardId(board) }; } finally { closeCellBoard(board); }
}

/** Serve the API over one fixture board with the given handler ports. */
async function served(t, entry, ports, options = {}) {
  const api = await serveApi({ projects: () => [entry], secret: SECRET, runCommand: async () => 0, isMain: false, refusalDocument,
    boardOpeners: { openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] }, viewPorts: VIEW_PORTS, handlerPorts: ports, ...options });
  t.after(() => api.close());
  return api;
}

/** A request to the served API, with its key; the signal lets a test drop a call that never answers. */
function call(api, path, { body, signal } = {}) {
  return fetch(`http://127.0.0.1:${api.port}${path}`, { method: body ? 'POST' : 'GET', signal,
    headers: { 'x-pullboard-key': SECRET, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

/** How long one health request takes to answer, and its body. */
async function timedHealth(api) {
  const started = performance.now();
  const response = await call(api, '/api/v1/health');
  const body = await response.json();
  return { ms: performance.now() - started, status: response.status, body };
}

/** Wait until `count` blocking handlers have said they are blocked. */
function blockedHandlers(t, channel, count) {
  const listener = new BroadcastChannel(channel);
  t.after(() => listener.close());
  let heard = 0;
  return new Promise((resolve) => { listener.onmessage = () => { if (++heard === count) resolve(); }; });
}

/** Send a jobs call that the test drops at its end, since its handler never answers in time. */
function droppedJobsCall(t, api, id, action = 'claim', extra = {}) {
  const abort = new AbortController();
  t.after(() => abort.abort());
  call(api, `/api/v1/boards/${id}/jobs`, { body: { action, runner: 'fixture-runner', ...extra }, signal: abort.signal }).catch(() => {});
}

test('api.pool.runner-job-action-age: clause 1 [C7]: authenticated health reports the active count and oldest age for an allowlisted runner action', { timeout: 30_000 }, async (t) => {
  const { entry, id } = fixtureBoard(t);
  const channel = `pool-action-${process.pid}`;
  const blocked = blockedHandlers(t, channel, 1);
  const api = await served(t, entry, handlerPorts({ channel, blockMs: 1_000 }));
  await timedHealth(api);
  droppedJobsCall(t, api, id, 'claim', { privatePayloadSentinel: 'must-not-appear' });
  await blocked;
  const health = await timedHealth(api);
  assert.equal(health.status, 200, JSON.stringify(health.body));
  assert.deepEqual(health.body.pool.runnerActions.claim, { busy: 1, oldestMs: health.body.pool.runnerActions.claim.oldestMs });
  assert.ok(Number.isFinite(health.body.pool.runnerActions.claim.oldestMs) && health.body.pool.runnerActions.claim.oldestMs >= 0, JSON.stringify(health.body.pool.runnerActions.claim));
  assert.deepEqual(Object.keys(health.body.pool.runnerActions).sort(), ['claim', 'progress', 'receipt', 'renew']);
  assert.equal(JSON.stringify(health.body).includes('privatePayloadSentinel'), false);
});

test('api.pool.runner-job-action-cleanup: clause 2 [C7]: finished and failed runner calls clear the action breakdown and raw job payload fields never enter health', { timeout: 30_000 }, async (t) => {
  const { entry, id } = fixtureBoard(t);
  const api = await served(t, entry, handlerPorts({ channel: `pool-finish-${process.pid}`, blockMs: 1, fail: false }));
  await timedHealth(api);
  const finished = await call(api, `/api/v1/boards/${id}/jobs`, { body: { action: 'renew', runner: 'fixture-runner', privatePayloadSentinel: 'never-health' } });
  assert.equal(finished.status, 200);
  const finishedHealth = (await timedHealth(api)).body;
  assert.deepEqual(finishedHealth.pool.runnerActions.renew, { busy: 0, oldestMs: 0 });
  assert.equal(JSON.stringify(finishedHealth).includes('never-health'), false);

  const failingApi = await served(t, entry, handlerPorts({ channel: `pool-fail-${process.pid}`, blockMs: 1, fail: true }));
  const failed = await call(failingApi, `/api/v1/boards/${id}/jobs`, { body: { action: 'receipt', runner: 'fixture-runner', privatePayloadSentinel: 'never-health' } });
  assert.equal(failed.status, 500);
  const failedHealth = (await timedHealth(failingApi)).body;
  assert.deepEqual(failedHealth.pool.runnerActions.receipt, { busy: 0, oldestMs: 0 });
  assert.equal(JSON.stringify(failedHealth).includes('never-health'), false);
});

test('api.pool.clause-request-handler-blocked-api: clause 1 [A2,C7]: with a request handler blocked for 30 s, the API answers health within 200 ms', { timeout: 30_000 }, async (t) => {
  const { entry, id } = fixtureBoard(t);
  const channel = `pool-one-${process.pid}`;
  const blocked = blockedHandlers(t, channel, 1);
  const api = await served(t, entry, handlerPorts({ channel, blockMs: 30_000 }));
  await timedHealth(api); // The first request pays for the connection; the timed one measures the answer.
  droppedJobsCall(t, api, id);
  await blocked;
  const health = await timedHealth(api);
  assert.equal(health.status, 200, JSON.stringify(health.body));
  assert.equal(health.body.ok, true);
  assert.equal(health.body.pool.busy, 1, 'the blocked handler holds one pool worker');
  assert.ok(health.ms < 200, `health took ${health.ms.toFixed(1)} ms with a handler blocked`);
});

test('api.pool.clause-every-pool-worker-blocked: clause 2 [A2,C7]: with every pool worker blocked, health answers within 200 ms and new work is refused API_BUSY instead of hanging', { timeout: 30_000 }, async (t) => {
  const { entry, id } = fixtureBoard(t);
  const channel = `pool-all-${process.pid}`;
  const api = await served(t, entry, handlerPorts({ channel, blockMs: 30_000 }));
  const workers = (await timedHealth(api)).body.pool.workers;
  assert.ok(workers >= 2, `the pool runs at least two workers, not ${workers}`);
  const blocked = blockedHandlers(t, channel, workers);
  for (let index = 0; index < workers; index++) droppedJobsCall(t, api, id);
  await blocked;
  const health = await timedHealth(api);
  assert.equal(health.status, 200, JSON.stringify(health.body));
  assert.equal(health.body.pool.busy, workers, 'every pool worker is held');
  assert.ok(health.ms < 200, `health took ${health.ms.toFixed(1)} ms with every worker blocked`);
  const started = performance.now();
  const refused = await call(api, `/api/v1/boards/${id}/jobs`, { body: { action: 'claim', runner: 'fixture-runner' }, signal: AbortSignal.timeout(10_000) });
  const body = await refused.json();
  const took = performance.now() - started;
  assert.equal(refused.status, 503, JSON.stringify(body));
  assert.equal(body.error.code, 'API_BUSY', JSON.stringify(body));
  assert.ok(took < 5_000, `the busy refusal took ${took.toFixed(0)} ms`); // budget: declared ceiling, a 1 s queue wait plus margin, never a hang.
});

test('api.pool.clause-request-thread-stall-over: clause 3 [A2,C7]: a request-thread stall over 500 ms is recorded as an api_stall board event naming the route', { timeout: 30_000 }, async (t) => {
  const { project, entry, id } = fixtureBoard(t);
  // The board lookup calls projects() on the request thread; the first lookup busy-waits 800 ms there.
  let stall = false;
  const projects = () => {
    if (stall) { stall = false; const until = Date.now() + 800; while (Date.now() < until) { /* A stalled request thread. */ } }
    return [entry];
  };
  let recorded;
  const stored = new Promise((resolve) => { recorded = resolve; });
  const api = await served(t, entry, handlerPorts(), { projects, watchdog: startLoopWatchdog, onStallRecord: recorded });
  t.mock.method(process.stderr, 'write', () => true);
  stall = true;
  const answered = await call(api, `/api/v1/boards/${id}/events?limit=1`);
  await answered.arrayBuffer();
  const result = await stored;
  assert.equal(result.recorded, 1, `the stall is recorded on the one board its route names: ${JSON.stringify(result)}`);
  const board = openBoardForRead(project.boardFile);
  let row;
  try { row = board.db.prepare("SELECT event_detail FROM event WHERE event_kind = 'api_stall' ORDER BY event_id DESC LIMIT 1").get(); } finally { closeCellBoard(board); }
  assert.ok(row, 'the board holds an api_stall event');
  const detail = JSON.parse(row.event_detail);
  assert.equal(detail.route, `GET /api/v1/boards/${id}/events`, JSON.stringify(detail));
  assert.ok(detail.lagMs > 500, `the recorded lag is ${detail.lagMs} ms`);
});
