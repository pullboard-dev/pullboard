/** An unexpected error behind the board API is answered as a generic SERVICE_ERROR and its stack is logged [A2,C7]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApiHandler } from '../../index.js';
import { fetchFresh } from '../../../../apps/cli/tests/fixtures/http.js';

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

test('clause 1 [P7]: a served board keeps answering after a commit lands that changes a module the server loads lazily (#6157)', { timeout: 120_000 }, async (t) => {
  const { once } = await import('node:events');
  const { join } = await import('node:path');
  const { Worker } = await import('node:worker_threads');
  const cell = await import('../../../store/tests/fixtures/cell.js');
  const store = await import('../../../store/index.js');
  const project = cell.cellProject(t);
  const opened = cell.openCellBoard(project.boardFile);
  let id;
  try { id = store.boardId(opened); } finally { cell.closeCellBoard(opened); }
  const code = cell.cellRepo(t);
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

test('clause 1: a thrown TypeError behind the real HTTP service is logged with its stack while the body stays the generic SERVICE_ERROR [A2,C7]', async (t) => {
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
