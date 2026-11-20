/** The board API serves a runner's job calls ahead of agent moves when its handler pool is busy, so agent traffic never starves the runners [A2,C7,P7,#10786]. */
import assert from 'node:assert/strict';
import { BroadcastChannel } from 'node:worker_threads';
import { test } from 'node:test';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { boardId } from '../../../store/index.js';
import { openBoardForRead } from '../../../store/index.js';
import { LEASE_MS } from '../../../jobs/index.js';
import { offerJob } from '../../index.js';
import { serveApi } from '../../index.js';
import { createApiHandler } from '../../index.js';
import { Refused } from '../../../kernel/index.js';
import { createServer } from 'node:http';

const SECRET = 'fixture-secret';
const CELL = new URL('../../../store/tests/fixtures/cell.js', import.meta.url).href;
const STORE = new URL('../../../store/index.js', import.meta.url).href;
const API = new URL('../../index.js', import.meta.url).href;
const JOB = 'test:http-lane';
const GREEN = { status: 0, gate: { green: true } };

/** The renderer the API takes as a port: a refusal becomes its public error body. */
function refusalDocument(error) {
  return { error: { code: error.code ?? 'INTERNAL', message: String(error.message) } };
}

/** View projections the handler requires at construction; these tests never project state. */
const VIEW_PORTS = Object.freeze(Object.fromEntries(['projectState', 'activeViewAgents', 'viewProofSummary', 'compactItemSummaries', 'viewFlowSummary']
  .map((name) => [name, () => { throw new Error(`these tests do not project ${name}`); }])));

/**
 * A handler ports module, as a data: URL: the API's real pool handlers over the fixture board, the runner job queue
 * among them with a hop table provided, with an agent move as the test hook. A move tells `channel` it started and busy-waits `blockMs` in its
 * worker, as a slow move holds a worker on a loaded board, then answers 200.
 */
function handlerPorts(channel, blockMs) {
  const source = `import { BroadcastChannel } from 'node:worker_threads';
import { openCellBoard } from ${JSON.stringify(CELL)};
import { openBoardForRead } from ${JSON.stringify(STORE)};
import { poolHandlers } from ${JSON.stringify(API)};
import { provideGateHopTable } from ${JSON.stringify(API)};
export function boardHandlerPorts({ isMain }) {
  // As pullboard serve does, the worker is given a hop table; only a gate job's claim reads it, and these jobs are test jobs.
  provideGateHopTable(() => () => ({ refused: { code: 'HOP_FENCED', message: 'these tests offer no gate job' } }));
  return { handlers: { ...poolHandlers({ boardOpeners: { openBoard: openCellBoard, openBoardForRead } }, { isMain }), move() {
    const channel = new BroadcastChannel(${JSON.stringify(channel)});
    channel.postMessage('moving');
    channel.close();
    const until = Date.now() + ${blockMs};
    while (Date.now() < until) { /* The test hook busy-waits inside the handler, as a slow move does. */ }
    return { status: 200, body: { moved: true } };
  } } };
}
`;
  return 'data:text/javascript,' + encodeURIComponent(source);
}

/** A fixture project with one runner job offered on its board, its registry entry and its board's persistent id. */
function fixtureBoard(t) {
  const project = cellProject(t, { real: true });
  const board = openCellBoard(project.boardFile);
  try {
    offerJob(board.db, { id: JOB, kind: 'test' });
    return { entry: { root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-17' }, id: boardId(board) };
  } finally { closeCellBoard(board); }
}

/** Serve the API over one fixture board, its clock read through `clock.skew` so a test can let a lease lapse. */
async function served(t, entry, ports, clock = { skew: 0 }, viewPorts = VIEW_PORTS) {
  const api = await serveApi({ projects: () => [entry], secret: SECRET, runCommand: async () => 0, isMain: false, refusalDocument, now: () => Date.now() + clock.skew,
    boardOpeners: { openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] }, viewPorts, handlerPorts: ports });
  t.after(() => api.close());
  return api;
}

/** One request to the served API with its key; the signal lets a test drop a call it never reads. */
async function call(api, path, { body, signal = AbortSignal.timeout(15_000) } = {}) {
  const response = await fetch(`http://127.0.0.1:${api.port}${path}`, { method: body ? 'POST' : 'GET', signal,
    headers: { 'x-pullboard-key': SECRET, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}

/** Resolve once `count` agent moves have taken a worker. */
function movesStarted(t, channel, count) {
  const listener = new BroadcastChannel(channel);
  t.after(() => listener.close());
  let heard = 0;
  return new Promise((resolve) => { listener.onmessage = () => { if (++heard === count) resolve(); }; });
}

/** Fill every worker agent calls may take with a blocked move, as ~20 agents did on 17 Nov, and answer the pool's health. */
async function busyWithMoves(t, api, id, channel) {
  const { body } = await call(api, '/api/v1/health');
  const agentWorkers = body.pool.workers - body.pool.runnerWorkers;
  assert.ok(body.pool.runnerWorkers >= 1, `a worker is kept for runner job calls: ${JSON.stringify(body.pool)}`);
  const started = movesStarted(t, channel, agentWorkers);
  for (let index = 0; index < agentWorkers; index++) {
    const abort = new AbortController();
    t.after(() => abort.abort());
    call(api, `/api/v1/boards/${id}/moves`, { body: { verb: 'note' }, signal: abort.signal }).catch(() => {});
  }
  await started;
  return body.pool;
}

/** One runner job queue call, as a runner posts it. */
function jobs(api, id, body) {
  return call(api, `/api/v1/boards/${id}/jobs`, { body });
}

test('api.http.busy-serves-runner-jobs-refuses-moves: clause 1: with the API at its busy limit, a runner\'s job pull, renewal and receipt post are served while an agent move is refused API_BUSY [A2,C7,P7]', { timeout: 60_000 }, async (t) => {
  const { entry, id } = fixtureBoard(t);
  const channel = `http-busy-${process.pid}`;
  const api = await served(t, entry, handlerPorts(channel, 30_000));
  await busyWithMoves(t, api, id, channel);
  const refused = await call(api, `/api/v1/boards/${id}/moves`, { body: { verb: 'note' } });
  assert.equal(refused.status, 503, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'API_BUSY', JSON.stringify(refused.body));
  const pulled = await jobs(api, id, { action: 'claim', runner: 'fixture-runner' });
  assert.equal(pulled.status, 200, JSON.stringify(pulled.body));
  assert.equal(pulled.body.claim?.job, JOB, 'the runner pulls the queued job while agent moves fill the pool');
  const renewed = await jobs(api, id, { action: 'renew', job: JOB, runner: 'fixture-runner', token: pulled.body.claim.token });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  assert.equal(renewed.body.renewed, true, JSON.stringify(renewed.body));
  const receipt = await jobs(api, id, { action: 'receipt', job: JOB, runner: 'fixture-runner', token: pulled.body.claim.token, receipt: GREEN });
  assert.equal(receipt.status, 200, JSON.stringify(receipt.body));
  assert.equal(receipt.body.recorded, true, JSON.stringify(receipt.body));
  const again = await call(api, `/api/v1/boards/${id}/moves`, { body: { verb: 'note' } });
  assert.equal(again.body.error?.code, 'API_BUSY', 'agent moves are still refused: the runner calls took no agent worker');
});

test('api.http.lapsed-lease-returns-to-queue: clause 2: with the API busy, a job lease that lapses while its runner cannot reach the board returns the job to the queue: another runner pulls it and the silent runner\'s late renewal is refused [A2,C7,P7]', { timeout: 60_000 }, async (t) => {
  const { entry, id } = fixtureBoard(t);
  const channel = `http-lapse-${process.pid}`;
  const clock = { skew: 0 };
  const api = await served(t, entry, handlerPorts(channel, 30_000), clock);
  await busyWithMoves(t, api, id, channel);
  const first = (await jobs(api, id, { action: 'claim', runner: 'silent-runner' })).body.claim;
  assert.equal(first?.job, JOB, 'the first runner pulls the job');
  assert.equal((await jobs(api, id, { action: 'claim', runner: 'other-runner' })).body.claim, null, 'a live lease keeps the job off the queue');
  clock.skew = LEASE_MS + 1_000; // The silent runner could not reach the board for a whole lease: no renewal arrived.
  const second = await jobs(api, id, { action: 'claim', runner: 'other-runner' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.claim?.job, JOB, 'the lapsed job went back to the queue and another runner pulled it');
  assert.equal(second.body.claim.attempt, 2);
  const late = await jobs(api, id, { action: 'renew', job: JOB, runner: 'silent-runner', token: first.token });
  assert.notEqual(late.body.renewed, true, `the silent runner's late renewal does not take the job back: ${JSON.stringify(late.body)}`);
  const receipt = await jobs(api, id, { action: 'receipt', job: JOB, runner: 'other-runner', token: second.body.claim.token, receipt: GREEN });
  assert.equal(receipt.body.recorded, true, JSON.stringify(receipt.body));
});

test('api.http.not-busy-serves-every-caller: clause 3: with the API not busy, agent moves and runner job calls through http.js are each served as before [A2,C7,P7]', { timeout: 60_000 }, async (t) => {
  const { entry, id } = fixtureBoard(t);
  const api = await served(t, entry, handlerPorts(`http-calm-${process.pid}`, 200));
  const { body } = await call(api, '/api/v1/health');
  const agentWorkers = body.pool.workers - body.pool.runnerWorkers;
  assert.ok(agentWorkers >= 1, `agent calls keep at least one worker: ${JSON.stringify(body.pool)}`);
  const moves = await Promise.all(Array.from({ length: agentWorkers }, () => call(api, `/api/v1/boards/${id}/moves`, { body: { verb: 'note' } })));
  assert.deepEqual(moves.map((moved) => [moved.status, moved.body.moved]), moves.map(() => [200, true]), 'every concurrent agent move is served');
  const pulled = await jobs(api, id, { action: 'claim', runner: 'fixture-runner' });
  assert.equal(pulled.body.claim?.job, JOB, JSON.stringify(pulled.body));
  assert.equal((await jobs(api, id, { action: 'renew', job: JOB, runner: 'fixture-runner', token: pulled.body.claim.token })).body.renewed, true);
  assert.equal((await jobs(api, id, { action: 'receipt', job: JOB, runner: 'fixture-runner', token: pulled.body.claim.token, receipt: GREEN })).body.recorded, true);
  const moved = await call(api, `/api/v1/boards/${id}/moves`, { body: { verb: 'note' } });
  assert.deepEqual([moved.status, moved.body.moved], [200, true], 'an agent move after the runner calls is served');
  const after = (await call(api, '/api/v1/health')).body.pool;
  assert.deepEqual([after.busy, after.queued], [0, 0], 'nothing is left held or queued');
});

/** A fixture project whose board holds one seat that has claimed one item, and one open item nobody holds. */
function seatBoard(t) {
  const project = cellProject(t, { real: true });
  const board = openCellBoard(project.boardFile);
  try {
    const seat = cellSeat(board, { lane: 'web', path: '/fixture/seat-a' });
    const held = cellItem(board, { lane: 'web', title: 'The seat holds this one', criterion: '1. web/a.js exists [command]' });
    cellItem(board, { lane: 'web', title: 'Nobody holds this one', criterion: '1. web/b.js exists [command]' });
    cellClaim(board, held.item_id, seat, { root: project.repo });
    return { entry: { root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-18' }, id: boardId(board), seat: seat.id, held: held.item_id };
  } finally { closeCellBoard(board); }
}

test('api.http.agent-route-answers-one-seat: clause 1: GET /api/v1/boards/<id>/agents/<agent> answers 200 with agent_id, agent_lane, agent_route and the ids of the items that seat holds claimed, and an unknown agent answers NO_AGENT [P7]', { timeout: 60_000 }, async (t) => {
  const { entry, id, seat, held } = seatBoard(t);
  const api = await served(t, entry, undefined);
  const answered = await call(api, `/api/v1/boards/${id}/agents/${seat}`);
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.deepEqual(answered.body, { agent_id: seat, agent_lane: 'web', agent_route: 'strong', claimed: [held], version: 1 });
  const unknown = await call(api, `/api/v1/boards/${id}/agents/no-such-seat`);
  assert.equal(unknown.body.error?.code, 'NO_AGENT', JSON.stringify(unknown.body));
});

test('api.http.agent-route-skips-state: clause 2: the agent route answers without calling the adapter\'s state build, so a counting state stub stays at 0 [P7]', { timeout: 60_000 }, async (t) => {
  const { entry, id, seat } = seatBoard(t);
  let builds = 0;
  const counting = Object.fromEntries(Object.keys(VIEW_PORTS).map((name) => [name, () => { builds++; throw new Error(`the agent route must not project ${name}`); }]));
  const api = await served(t, entry, undefined, { skew: 0 }, counting);
  const answered = await call(api, `/api/v1/boards/${id}/agents/${seat}`);
  assert.equal(answered.status, 200, JSON.stringify(answered.body));
  assert.equal(builds, 0, 'no view projection ran for the agent read');
});

/** The status and refusal code the job route answers when the board's job call refuses with this code, over a loopback server. */
async function jobRefusal(t, code) {
  const handler = createApiHandler({ refusalDocument,
    authenticate: () => ({ local: true }),
    board: (id) => ({ id }),
    jobs: () => { throw new Refused(code, `the board refused ${code}`); },
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/boards/fixture/jobs`, { method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ action: 'claim', runner: 'r-a', capabilities: [] }) });
  return [response.status, (await response.json()).error.code];
}

test('api.io-refusal.board-busy-503: clause 1: a job call the board refuses BOARD_BUSY answers HTTP 503, so the runner retries it instead of ending its serve [C7]', async (t) => {
  assert.deepEqual(await jobRefusal(t, 'BOARD_BUSY'), [503, 'BOARD_BUSY']);
});

test('api.io-refusal.job-write-timeout-503: clause 1: a job call the board refuses JOB_WRITE_TIMEOUT answers HTTP 503, and another refusal still answers 400 [C7]', async (t) => {
  assert.deepEqual(await jobRefusal(t, 'JOB_WRITE_TIMEOUT'), [503, 'JOB_WRITE_TIMEOUT']);
  assert.deepEqual(await jobRefusal(t, 'JOB_RECEIPT'), [400, 'JOB_RECEIPT'], 'a refusal of the call itself stays a 400');
});
