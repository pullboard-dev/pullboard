/** @pullboard-test-input source-cell packages/api */
/** @pullboard-world-pin reads the board door's own import lines to prove it reaches the stats cell through its light door, never the barrel; a changed specifier fails the case [C7]. */
/** An unexpected error behind the board API is answered as a generic SERVICE_ERROR and its stack is logged [A2,C7]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApiHandler } from '../../index.js';
import { fetchFresh } from '../../../sync/tests/fixtures/http.js';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { closeCellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { FIXTURE_MODEL } from '../../../store/tests/fixtures/cell.js';
import { boardId } from '../../../store/index.js';
import { openBoardForRead } from '../../../store/index.js';
import { serveApi } from '../../index.js';
import { createLocalApiHandler } from '../../index.js';
import { createHash } from 'node:crypto';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { listBoardMetaWithPrefix } from '../../../store/index.js';

/** The renderer the API takes as a port: a refusal becomes its public error body. */
function refusalDocument(error) {
  return { error: { code: error.code ?? 'INTERNAL', message: String(error.message) } };
}

/**
 * The served board API a moved checkout restarts, run as a worker: each worker loads its own module graph, as a fresh
 * process does. It requires shared.cjs at start and reader.cjs on its first request, and asks the test to relaunch it.
 */
const MOVING_SERVER = `import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parentPort, threadId, workerData } from 'node:worker_threads';
const { port, board, modules } = workerData;
const { serveApi } = await import(modules.api);
const { restartOnCodeMove } = await import(modules.drive);
const { openBoardForRead } = await import(modules.store);
const { openCellBoard } = await import(modules.cell);
const require = createRequire(import.meta.url);
require('./shared.cjs');
const viewPorts = Object.fromEntries(['projectState', 'activeViewAgents', 'viewProofSummary', 'compactItemSummaries', 'viewFlowSummary'].map((name) => [name, () => null]));
const projects = () => { require('./reader.cjs').check(); return [{ root: board, name: 'fixture', project: 'fixture', added: '2026-11-12' }]; };
const api = await serveApi({ port, projects, secret: 'fixture-secret', runCommand: async () => 0, isMain: false, viewPorts,
  refusalDocument: (error) => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }),
  boardOpeners: { openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] } });
const here = fileURLToPath(new URL('.', import.meta.url));
const revision = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
const fresh = restartOnCodeMove({ root: here, revision, close: api.close, interval: 100, log: () => {},
  relaunch: () => { parentPort.postMessage({ relaunch: api.port }); return { pid: null }; } });
parentPort.postMessage({ started: threadId, port: api.port });
await fresh.restarted;
`;

test('api.main.clause-served-board-keeps-answering: clause 1 [P7]: a served board keeps answering after a commit lands that changes a module the server loads lazily (#6157)', { timeout: 120_000 }, async (t) => {
  const { once } = await import('node:events');
  const { join } = await import('node:path');
  const { Worker } = await import('node:worker_threads');
  const cell = await import('../../../store/tests/fixtures/cell.js');
  const boardCell = await import('../../../board/tests/fixtures/cell-board.js');
  const store = await import('../../../store/index.js');
  const project = cell.cellProject(t, { real: true });
  const opened = boardCell.openCellBoard(project.boardFile);
  let id;
  try { id = store.boardId(opened); } finally { boardCell.closeCellBoard(opened); }
  const code = cell.cellRepo(t, { real: true });
  code.put('shared.cjs', 'exports.one = () => 1;\n');
  code.put('reader.cjs', "module.exports.check = () => require('./shared.cjs').one();\n");
  code.put('server.mjs', MOVING_SERVER);
  code.commitAll();
  const url = (path) => new URL(path, import.meta.url).href;
  const modules = { api: url('../../index.js'), drive: url('../../../drive/index.js'), store: url('../../../store/index.js'), cell: url('../../../board/tests/fixtures/cell-board.js') };
  const servers = [];
  t.after(() => Promise.all(servers.map((server) => server.terminate())));
  /** Start the server from the code tree as it is now, and answer its first message: started, port. */
  const start = async (port) => {
    // No inherited execArgv: the test runner's own preload belongs to this file's thread alone.
    const server = new Worker(join(code.root, 'server.mjs'), { workerData: { port, board: project.repo, modules }, execArgv: [] });
    servers.push(server);
    const [message] = await once(server, 'message');
    assert.ok(message.started, JSON.stringify(message));
    return { server, ...message };
  };
  const first = await start(0);
  const relaunched = once(first.server, 'message');
  // The landing: a module loaded at start gains a name that a module the server has not loaded yet now needs.
  code.put('shared.cjs', 'exports.two = () => 2;\n');
  code.put('reader.cjs', "module.exports.check = () => require('./shared.cjs').two();\n");
  code.commitAll();
  const [asked] = await relaunched;
  assert.equal(asked.relaunch, first.port, 'the old server asks for a relaunch on its own port once it stopped serving');
  const second = await start(asked.relaunch);
  assert.notEqual(second.started, first.started, 'a fresh server with its own module graph serves the new code');
  assert.equal(second.port, first.port, 'the restarted server keeps its port');
  const response = await fetch(`http://127.0.0.1:${first.port}/api/v1/boards/${id}/events?k=fixture-secret`);
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.notEqual(body.error?.code, 'NO_BOARD');
  assert.ok(Array.isArray(body.events), `a board-backed answer: ${JSON.stringify(body)}`);
});

test('api.main.thrown-typeerror-behind-real-http: clause 1: a thrown TypeError behind the real HTTP service is logged with its stack while the body stays the generic SERVICE_ERROR [A2,C7]', async (t) => {
  const logged = [];
  t.mock.method(process.stderr, 'write', (chunk) => { logged.push(String(chunk)); return true; });
  const handler = createApiHandler({ refusalDocument,
    authenticate: () => ({ user: 'fixture-user' }),
    board: (id) => ({ id }),
    stateJson: () => { throw new TypeError('fixture state serializer exploded'); },
    eventLogVersion: () => 'v1',
  });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const response = await fetchFresh('http://127.0.0.1:' + server.address().port + '/api/v1/boards/fixture/state?seen=1');
  const text = await response.text();
  assert.equal(response.status, 500);
  assert.equal(JSON.parse(text).error.code, 'SERVICE_ERROR');
  assert.equal(text.includes('exploded'), false, 'the response body does not leak the original message');
  assert.equal(text.includes('TypeError'), false, 'the response body does not leak the stack');
  const log = logged.join('');
  assert.match(log, /TypeError: fixture state serializer exploded/u, 'the original message is logged');
  assert.match(log, /\n\s+at /u, 'the stack is logged');
});

/** The board openers the higher composition root hands the API, over the store's own fixture board. */
const OPENERS = Object.freeze({ openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] });

/** View projections the handler requires at construction; an events read never calls them. */
const VIEW_PORTS = Object.freeze(Object.fromEntries(['projectState', 'activeViewAgents', 'viewProofSummary', 'compactItemSummaries', 'viewFlowSummary']
  .map((name) => [name, () => { throw new Error(`an events read does not project ${name}`); }])));

/** Serve the board API over the given registered projects and read one board's events by id. */
async function readEvents(t, projects, id) {
  const secret = 'fixture-secret';
  const api = await serveApi({ projects: () => projects, secret, runCommand: async () => 0, isMain: false, refusalDocument, boardOpeners: OPENERS, viewPorts: VIEW_PORTS });
  t.after(() => api.close());
  const response = await fetchFresh(`http://127.0.0.1:${api.port}/api/v1/boards/${id}/events?k=${secret}`);
  return { status: response.status, body: await response.json() };
}

/** The persistent id of a fixture project's board. */
function fixtureBoardId(project) {
  const board = openCellBoard(project.boardFile);
  try { return boardId(board); } finally { closeCellBoard(board); }
}

test('api.main.clause-registered-board-cannot-read: clause 1 [P7]: a registered board that cannot be read is logged with its code, message and board id, and the refusal names the read failure instead of NO_BOARD (#6158)', async (t) => {
  const project = cellProject(t, { real: true });
  const id = fixtureBoardId(project);
  writeFileSync(project.boardFile, 'this is not a SQLite database, so every read of the board fails\n'.repeat(64));
  const logged = [];
  t.mock.method(process.stderr, 'write', (chunk) => { logged.push(String(chunk)); return true; });
  const answer = await readEvents(t, [{ root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-12' }], id);
  assert.notEqual(answer.body.error?.code, 'NO_BOARD', JSON.stringify(answer.body));
  assert.equal(answer.body.error?.code, 'BOARD_UNAVAILABLE', JSON.stringify(answer.body));
  assert.match(answer.body.error.message, /could not be read/u, 'the refusal names the read failure');
  assert.ok(answer.body.error.message.includes(project.repo), 'the refusal names the unreadable board');
  const line = logged.join('').split('\n').find((entry) => entry.startsWith('pullboard: board read failed'));
  assert.ok(line, `the read failure is logged: ${logged.join('')}`);
  assert.ok(line.includes(`board ${id}`), 'the log line carries the asked board id');
  assert.match(line, /: \S+ \S/u, 'the log line carries the error code and message');
  assert.match(line, /not a database|SQLITE|file/iu, 'the log line carries the underlying SQLite error');
});

test('api.main.clause-board-registered-board-carries: clause 1 [P7]: a board id no registered board carries still answers NO_BOARD when every board reads (#6158)', async (t) => {
  const project = cellProject(t, { real: true });
  fixtureBoardId(project);
  const logged = [];
  t.mock.method(process.stderr, 'write', (chunk) => { logged.push(String(chunk)); return true; });
  const answer = await readEvents(t, [{ root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-12' }], 'no-such-board');
  assert.equal(answer.status, 404, JSON.stringify(answer.body));
  assert.equal(answer.body.error.code, 'NO_BOARD');
  assert.equal(logged.join('').includes('board read failed'), false, 'a readable board logs no read failure');
});

test('api.main.clause-landing-touches-only-docs: clause 1 [P7]: a landing that touches only docs or unrelated cells keeps the served process, a served-module landing restarts it (#6162)', { timeout: 60_000 }, async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { join } = await import('node:path');
  const { restartOnCodeMove, servedModuleMoved } = await import('../../../drive/index.js');
  const cell = await import('../../../store/tests/fixtures/cell.js');
  const code = cell.cellRepo(t, { real: true });
  code.put('entry.mjs', "import './served.mjs';\nawait import('./lazy.mjs');\n");
  code.put('served.mjs', 'export const one = 1;\n');
  code.put('lazy.mjs', 'export const lazy = 1;\n');
  code.put('docs/guide.md', 'one\n');
  code.put('cells/unrelated.mjs', 'export const unrelated = 1;\n');
  code.commitAll();
  const revision = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: code.root, encoding: 'utf8' }).trim();
  let closed = 0, relaunched = 0, skipped;
  const unaffected = new Promise((done) => { skipped = done; });
  const judge = servedModuleMoved({ root: code.root, entries: [join(code.root, 'entry.mjs')] });
  const fresh = restartOnCodeMove({ root: code.root, revision, interval: 25, drain: 25, log: () => {},
    affects: async (from, to) => { const answer = await judge(from, to); if (!answer) skipped(); return answer; },
    close: async () => { closed++; }, relaunch: () => { relaunched++; return { pid: null }; } });
  // The watcher's timer is unref'd for a server that has other work; this test has none, so it holds the loop open.
  const hold = setInterval(() => {}, 1_000);
  t.after(() => { clearInterval(hold); fresh.stop(); });
  code.put('docs/guide.md', 'two\n');
  code.put('cells/unrelated.mjs', 'export const unrelated = 2;\n');
  code.commitAll();
  await unaffected;
  assert.equal(closed, 0, 'a docs and unrelated-cell landing never stops listening');
  assert.equal(relaunched, 0, 'a docs and unrelated-cell landing starts no new process');
  code.put('lazy.mjs', 'export const lazy = 2;\n');
  code.commitAll();
  const moved = await fresh.restarted;
  assert.equal(closed, 1, 'a landing that changes a served module stops the old server');
  assert.equal(relaunched, 1, 'a landing that changes a served module relaunches it once');
  assert.equal(moved.to, revision());
});

/** The board key pullboard serve shares with every runner and seat when it listens on a network address. */
const BOARD_KEY = 'fixture-board-key';

/** The coordinator's own secret, separate from the board key, when the handler is given one. */
const COORDINATOR_KEY = 'coordinator-own';

/** A move runner that records each call and answers as the CLI does: a JSON result and one event of the move's kind. */
function recordingRunner() {
  const calls = [];
  const run = async (argv, options) => {
    calls.push({ argv, remoteAgent: options.remoteAgent ?? null });
    options.stdout.write('{}');
    options.onEvent({ event_id: calls.length, event_kind: argv[0] });
    return 0;
  };
  return { calls, run };
}

/**
 * The board API handler as serveApi builds it for pullboard serve: the api channel and the given key, answering the
 * network address it was started on (allowedHosts) unless the options say otherwise; it listens on loopback here.
 */
async function servedMoves(t, project, options = {}) {
  let port;
  const runner = recordingRunner();
  const handler = createLocalApiHandler({ secret: BOARD_KEY, getPort: () => port, runCommand: runner.run, isMain: false, personChannel: 'api', allowedHosts: ['192.0.2.10'],
    projects: () => [{ root: project.repo, name: 'fixture', project: 'fixture', added: '2026-11-17' }], refusalDocument, boardOpeners: OPENERS, viewPorts: VIEW_PORTS, ...options });
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  port = server.address().port;
  t.after(() => new Promise((done) => { handler.close(); server.close(done); server.closeIdleConnections(); }));
  const id = fixtureBoardId(project);
  const move = async (body, headers = { 'x-pullboard-key': BOARD_KEY }) => {
    const response = await fetchFresh(`http://127.0.0.1:${port}/api/v1/boards/${id}/moves`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { move, calls: runner.calls };
}

/** A fact move on item 1; the recording runner never reads the item. */
const FACT = Object.freeze({ verb: 'fact', item: 1, args: { kind: 'note', text: 'fixture note' } });

test('api.main.no-agent-move-refused: clause 1 [P7]: a move posted with the shared board key and no agent is refused with AGENT_REQUIRED and runs nothing as the coordinator; a loopback session secret still moves as the coordinator (#10785)', async (t) => {
  const project = cellProject(t, { real: true });
  const served = await servedMoves(t, project);
  const refused = await served.move(FACT);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'AGENT_REQUIRED');
  assert.equal(served.calls.length, 0, 'no command ran for the refused move');
  // A loopback serve's own session secret is the coordinator's credential, as the view's session is: unchanged.
  const local = await servedMoves(t, project, { allowedHosts: [] });
  const moved = await local.move(FACT);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.event.event_kind, 'fact');
  assert.deepEqual(local.calls, [{ argv: ['fact'], remoteAgent: null }], 'the move ran once at the board root as the coordinator');
});

test('api.main.coordinator-move-needs-own-credential: clause 2 [P7]: a move naming the coordinator is refused with the shared board key, and runs only with the coordinator\'s own separate credential (#10785)', async (t) => {
  const project = cellProject(t, { real: true });
  const coordinatorMove = { ...FACT, agent: 'coordinator' };
  const plain = await servedMoves(t, project);
  for (const headers of [{ 'x-pullboard-key': BOARD_KEY }, { 'x-pullboard-key': BOARD_KEY, 'x-pullboard-coordinator-key': BOARD_KEY }]) {
    const refused = await plain.move(coordinatorMove, headers);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.equal(refused.body.error.code, 'COORDINATOR_CREDENTIAL', 'the board key never stands in for the coordinator\'s credential');
  }
  assert.equal(plain.calls.length, 0, 'no coordinator command ran on the board key');
  const owned = await servedMoves(t, project, { coordinatorSecret: COORDINATOR_KEY });
  const keyOnly = await owned.move(coordinatorMove);
  assert.equal(keyOnly.body.error?.code, 'COORDINATOR_CREDENTIAL', JSON.stringify(keyOnly.body));
  const credential = { 'x-pullboard-key': BOARD_KEY, 'x-pullboard-coordinator-key': COORDINATOR_KEY };
  const named = await owned.move(coordinatorMove, credential);
  assert.equal(named.status, 200, JSON.stringify(named.body));
  const unnamed = await owned.move(FACT, credential);
  assert.equal(unnamed.status, 200, JSON.stringify(unnamed.body));
  assert.deepEqual(owned.calls, [{ argv: ['fact'], remoteAgent: null }, { argv: ['fact'], remoteAgent: null }], 'both ran as the coordinator, at the board root');
});

test('api.main.seat-moves-with-board-key: clause 3 [P7]: through packages/api/src/io/main.js a seat joins with the shared board key, and its own moves, sent with the board key and the key its join issued, run as that seat (#10785,#10790)', async (t) => {
  const project = cellProject(t, { real: true });
  const served = await servedMoves(t, project);
  const joined = await served.move({ verb: 'join', args: { lane: 'api', model: FIXTURE_MODEL, family: 'anthropic' } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const seat = joined.body.result.agent;
  assert.match(String(seat), /\S/u, 'the join names the new seat');
  const moved = await served.move({ ...FACT, agent: seat }, seatHeaders(joined.body.result.key));
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.event.event_kind, 'fact');
  assert.deepEqual(served.calls, [{ argv: ['fact'], remoteAgent: seat }], 'the move ran once as the seat that named itself');
});

/** The headers a seat joined over the API sends: the shared board key and its own seat key. */
function seatHeaders(key) {
  return { 'x-pullboard-key': BOARD_KEY, 'x-pullboard-seat-key': key };
}

/** Join one seat over the served API with the board key alone, and return its name and the key the join issued. */
async function joinSeat(served) {
  const joined = await served.move({ verb: 'join', args: { lane: 'api', model: FIXTURE_MODEL, family: 'anthropic' } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { agent: joined.body.result.agent, key: joined.body.result.key };
}

test('api.main.join-issues-own-seat-key: clause 1 [P7]: joining a seat over the board API issues that seat its own key, kept on the board only as a digest, and a move naming the seat with a different seat\'s key is refused SEAT_CREDENTIAL before anything runs (#10790)', async (t) => {
  const project = cellProject(t, { real: true });
  const served = await servedMoves(t, project);
  const first = await joinSeat(served);
  const second = await joinSeat(served);
  for (const seat of [first, second]) assert.match(String(seat.key), /^[\w-]{43}$/u, 'each join returns a 256-bit key');
  assert.notEqual(first.key, second.key, 'each seat gets its own key');
  const board = openCellBoard(project.boardFile);
  let kept;
  try { kept = listBoardMetaWithPrefix(board.db, '').map(({ value }) => String(value)); } finally { closeCellBoard(board); }
  for (const { key } of [first, second]) {
    assert.equal(kept.some((value) => value.includes(key)), false, 'the board never stores a seat key itself');
    assert.ok(kept.includes(createHash('sha256').update(key).digest('hex')), 'the board keeps the key\'s digest');
  }
  const crossed = await served.move({ ...FACT, agent: first.agent }, seatHeaders(second.key));
  assert.equal(crossed.status, 403, JSON.stringify(crossed.body));
  assert.equal(crossed.body.error.code, 'SEAT_CREDENTIAL');
  const carried = await served.move({ verb: 'submit', item: 1, args: {}, agent: first.agent, commits: { bundle: 'AA==' } }, seatHeaders(second.key));
  assert.equal(carried.body.error?.code, 'SEAT_CREDENTIAL', 'a submit carrying commits is refused before its commits are taken');
  assert.equal(served.calls.length, 0, 'no command ran as a seat named with another seat\'s key');
});

test('api.main.seat-moves-with-own-key: clause 2 [P7]: a move naming the seat with its own key runs as today, a test receipt fact and next included; the coordinator\'s own credential still moves as any seat (#10790)', async (t) => {
  const project = cellProject(t, { real: true });
  const served = await servedMoves(t, project);
  const seat = await joinSeat(served);
  const receipt = { verb: 'fact', item: 1, args: { kind: 'note', text: 'test receipt: green pullboard test run of a.test.js at abc on studio in 1s (exit 0)' }, agent: seat.agent };
  for (const body of [{ ...FACT, agent: seat.agent }, receipt, { verb: 'next', args: {}, agent: seat.agent }]) {
    const moved = await served.move(body, seatHeaders(seat.key));
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.event.event_kind, body.verb);
  }
  assert.deepEqual(served.calls, ['fact', 'fact', 'next'].map((verb) => ({ argv: [verb], remoteAgent: seat.agent })), 'each move ran once as the seat');
  // A loopback serve's session secret is the coordinator's credential, as the view's session is: it acts as a seat with no seat key.
  const local = await servedMoves(t, project, { allowedHosts: [] });
  const asCoordinator = await local.move({ ...FACT, agent: seat.agent });
  assert.equal(asCoordinator.status, 200, JSON.stringify(asCoordinator.body));
  assert.deepEqual(local.calls, [{ argv: ['fact'], remoteAgent: seat.agent }]);
});

test('api.main.board-key-joins-not-moves: clause 3 [P7]: through packages/api/src/io/main.js the shared board key alone may join a seat but cannot move as an existing seat, joined over the API or in a worktree on the board host (#10790)', async (t) => {
  const project = cellProject(t, { real: true });
  const served = await servedMoves(t, project);
  const seat = await joinSeat(served);
  const worktree = cellRepo(t, { real: true }).root;
  const board = openCellBoard(project.boardFile);
  let hosted;
  try { hosted = cellSeat(board, { lane: 'api', path: worktree }).id; } finally { closeCellBoard(board); }
  for (const agent of [seat.agent, hosted]) {
    for (const headers of [{ 'x-pullboard-key': BOARD_KEY }, seatHeaders(''), seatHeaders(BOARD_KEY), seatHeaders(seat.key.slice(1))]) {
      const refused = await served.move({ ...FACT, agent }, headers);
      assert.equal(refused.status, 403, `${agent}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.error.code, 'SEAT_CREDENTIAL', 'the board key alone never moves as a seat');
    }
  }
  assert.equal(served.calls.length, 0, 'no command ran as a seat on the board key alone');
});

test('api.main.stats-through-light: clause 1 [C7]: no import in packages/api/src/io/main.js names the stats barrel, every stats import names the light entry', () => {
  const source = readFileSync(new URL('../../src/io/main.js', import.meta.url), 'utf8');
  const specifiers = [...source.matchAll(/from\s+'([^']*\/stats\/[^']*)'/gu)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, 'the board door still imports stats');
  assert.deepEqual(specifiers.filter((specifier) => !specifier.endsWith('/stats/light.js')), [], 'every stats import names the light entry');
  assert.equal(specifiers.includes('../../../stats/index.js'), false, 'the stats barrel is not imported');
});

/** Turn spec.commitOnApply on or off for the fixture machine this process reads, restoring the environment when the test ends. */
function commitOnApply(t, project, on) {
  const home = project.env.PULLBOARD_MACHINE_HOME;
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, { spec: { commitOnApply: on } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
}

/**
 * A move runner for the view's approve: an approve answers as the CLI does, and an apply of one row commits it in the real checkout,
 * or refuses APPLY_NOT_COMMITTED naming the one command left when the checkout is dirty; failApprove makes the approve itself refuse.
 */
function specRunner(project, { failApprove = false } = {}) {
  const calls = [];
  const run = async (argv, options) => {
    calls.push({ argv, personChannel: options.personChannel });
    if (argv[0] === 'spec-approve') {
      if (failApprove) { options.stdout.write(JSON.stringify({ error: { code: 'PERSON_UNSIGNED', message: 'not signed' } })); return 1; }
      options.stdout.write('{}');
      options.onEvent({ event_id: calls.length, event_kind: 'spec-approve' });
      return 0;
    }
    const row = argv[3];
    if (project.git(options.cwd, 'status', '--porcelain') !== '') {
      options.stdout.write(JSON.stringify({ error: { code: 'APPLY_NOT_COMMITTED', message: `the checkout has uncommitted changes, so ${row} was not committed`, next: `commit or stash the changes, then run pullboard spec apply --row ${row} --commit` } }));
      return 1;
    }
    appendFileSync(join(options.cwd, 'SPEC.md'), `\n- ${row} approved\n`);
    project.git(options.cwd, 'add', 'SPEC.md');
    project.git(options.cwd, 'commit', '-q', '-m', `docs(spec): approve ${row}`);
    options.stdout.write(JSON.stringify({ applied: { committed: true, commit: project.git(options.cwd, 'rev-parse', 'HEAD') } }));
    return 0;
  };
  return { calls, run };
}

/** The approve move the view posts for one row. */
const APPROVE = Object.freeze({ verb: 'spec-approve', args: { ids: 'G1' } });

test('api.main.spec-approve-applies-and-commits: clause 1: with spec.commitOnApply on and a clean checkout, a spec-approve on the view channel is followed by spec apply --row --commit --json through the same runner and the result carries applied.commit, the new head with the row approved in SPEC.md [C7,#11192]', async (t) => {
  const project = cellProject(t, { real: true });
  commitOnApply(t, project, true);
  const runner = specRunner(project);
  const served = await servedMoves(t, project, { allowedHosts: [], personChannel: 'view', runCommand: runner.run });
  const before = project.git(project.repo, 'rev-parse', 'HEAD');
  const moved = await served.move(APPROVE);
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(runner.calls.map((call) => call.argv), [['spec-approve'], ['spec', 'apply', '--row', 'G1', '--commit', '--json']], 'the apply ran once, after the approve, through the same runner');
  assert.deepEqual(runner.calls.map((call) => call.personChannel), ['view', 'view'], 'both ran on the person channel the approve came from');
  const head = project.git(project.repo, 'rev-parse', 'HEAD');
  assert.notEqual(head, before, 'a commit landed on the checkout');
  assert.equal(moved.body.result.applied.commit, head, 'the result names the new head');
  assert.match(project.git(project.repo, 'show', 'HEAD:SPEC.md'), /G1 approved/u, 'the new head holds the approved row');
});

test('api.main.spec-approve-dirty-names-command: clause 2: on a dirty checkout the head is unchanged and the result names the refusal\'s one command left; with the setting off, or an approve that did not succeed, no apply runs [C7,#11192]', async (t) => {
  const project = cellProject(t, { real: true });
  commitOnApply(t, project, true);
  const runner = specRunner(project);
  const served = await servedMoves(t, project, { allowedHosts: [], personChannel: 'view', runCommand: runner.run });
  writeFileSync(join(project.repo, 'notes.txt'), 'unrelated work\n');
  const before = project.git(project.repo, 'rev-parse', 'HEAD');
  const dirty = await served.move(APPROVE);
  assert.equal(dirty.status, 200, JSON.stringify(dirty.body));
  assert.equal(project.git(project.repo, 'rev-parse', 'HEAD'), before, 'nothing was committed');
  assert.equal(dirty.body.result.applied.committed, false);
  assert.equal(dirty.body.result.applied.left, 'commit or stash the changes, then run pullboard spec apply --row G1 --commit', 'the result names the one command left');
  commitOnApply(t, project, false);
  const off = specRunner(project);
  const servedOff = await servedMoves(t, project, { allowedHosts: [], personChannel: 'view', runCommand: off.run });
  const skipped = await servedOff.move(APPROVE);
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  assert.deepEqual(off.calls.map((call) => call.argv), [['spec-approve']], 'with the setting off only the approve ran');
  assert.equal(skipped.body.result.applied, undefined);
  commitOnApply(t, project, true);
  const failing = specRunner(project, { failApprove: true });
  const servedFailing = await servedMoves(t, project, { allowedHosts: [], personChannel: 'view', runCommand: failing.run });
  const refused = await servedFailing.move(APPROVE);
  assert.equal(refused.status, 409, JSON.stringify(refused.body));
  assert.deepEqual(failing.calls.map((call) => call.argv), [['spec-approve']], 'an approve that did not succeed runs no apply');
});
