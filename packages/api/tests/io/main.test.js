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

/** The served board API a moved checkout restarts: it requires shared.cjs at start and reader.cjs on each request. */
const MOVING_SERVER = `import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { port: { type: 'string' }, board: { type: 'string' }, api: { type: 'string' }, drive: { type: 'string' }, store: { type: 'string' }, cell: { type: 'string' } } });
const { serveApi } = await import(values.api);
const { restartOnCodeMove } = await import(values.drive);
const { openBoardForRead } = await import(values.store);
const { openCellBoard } = await import(values.cell);
const require = createRequire(import.meta.url);
require('./shared.cjs');
const viewPorts = Object.fromEntries(['projectState', 'activeViewAgents', 'viewProofSummary', 'compactItemSummaries', 'viewFlowSummary'].map((name) => [name, () => null]));
const projects = () => { require('./reader.cjs').check(); return [{ root: values.board, name: 'fixture', project: 'fixture', added: '2026-11-12' }]; };
const api = await serveApi({ port: Number(values.port), projects, secret: 'fixture-secret', runCommand: async () => 0, isMain: false, viewPorts,
  refusalDocument: (error) => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }),
  boardOpeners: { openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] } });
process.stdout.write(JSON.stringify({ pid: process.pid, port: api.port }) + '\\n');
const here = fileURLToPath(new URL('.', import.meta.url));
const revision = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
const fresh = restartOnCodeMove({ root: here, revision, close: api.close, interval: 100, log: () => {},
  command: () => [process.execPath, fileURLToPath(import.meta.url), ...process.argv.slice(2).filter((arg, index, all) => arg !== '--port' && all[index - 1] !== '--port'), '--port', String(api.port)] });
await fresh.restarted;
`;

test('clause 1 [P7]: a served board keeps answering after a commit lands that changes a module the server loads lazily (#6157)', { timeout: 120_000 }, async (t) => {
  const { spawn } = await import('node:child_process');
  const { join } = await import('node:path');
  const { createInterface } = await import('node:readline');
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
  // The restarted server inherits the first one's stdout, so each start is one line on the same pipe.
  const child = spawn(process.execPath, [join(code.root, 'server.mjs'), '--port', '0', '--board', project.repo,
    '--api', url('../../index.js'), '--drive', url('../../../drive/index.js'), '--store', url('../../../store/index.js'), '--cell', url('../../../store/tests/fixtures/cell.js')],
  { cwd: code.root, stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const started = [];
  t.after(() => { for (const { pid } of started) try { process.kill(pid); } catch { /* That server already stopped. */ } child.stdout.destroy(); });
  const nextStart = async () => {
    const { value, done } = await lines.next();
    assert.equal(done, false, 'the server printed its start');
    started.push(JSON.parse(value));
    return started.at(-1);
  };
  const first = await nextStart();
  // The landing: a module loaded at start gains a name that a module the server has not loaded yet now needs.
  code.put('shared.cjs', 'exports.two = () => 2;\n');
  code.put('reader.cjs', "module.exports.check = () => require('./shared.cjs').two();\n");
  code.commitAll();
  const second = await nextStart();
  assert.notEqual(second.pid, first.pid, 'a fresh process serves the new code');
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
