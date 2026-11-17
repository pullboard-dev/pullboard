/** An unexpected error behind the board API is answered as a generic SERVICE_ERROR and its stack is logged [A2,C7]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApiHandler } from '../../index.js';
import { fetchFresh } from '../../../../apps/cli/tests/fixtures/http.js';
import { writeFileSync } from 'node:fs';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../store/tests/fixtures/cell.js';
import { boardId } from '../../../store/index.js';
import { openBoardForRead } from '../../../store/index.js';
import { serveApi } from '../../index.js';

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
  const store = await import('../../../store/index.js');
  const project = cell.cellProject(t, { real: true });
  const opened = cell.openCellBoard(project.boardFile);
  let id;
  try { id = store.boardId(opened); } finally { cell.closeCellBoard(opened); }
  const code = cell.cellRepo(t, { real: true });
  code.put('shared.cjs', 'exports.one = () => 1;\n');
  code.put('reader.cjs', "module.exports.check = () => require('./shared.cjs').one();\n");
  code.put('server.mjs', MOVING_SERVER);
  code.commitAll();
  const url = (path) => new URL(path, import.meta.url).href;
  const modules = { api: url('../../index.js'), drive: url('../../../drive/index.js'), store: url('../../../store/index.js'), cell: url('../../../store/tests/fixtures/cell.js') };
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
