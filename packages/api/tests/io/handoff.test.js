/** The board API restarts onto new code without refusing a request: the new process listens on the old one's socket first [C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Agent } from 'node:http';
import { createServer } from 'node:http';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { restartOnCodeMove } from '../../../drive/index.js';
import { boardId } from '../../../store/index.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { openCellBoard } from '../../../store/tests/fixtures/cell.js';
import { closeCellBoard } from '../../../store/tests/fixtures/cell.js';
import { startServedNode } from '../fixtures/served.js';

/**
 * The served board API as `pullboard serve` wires its restart: it listens on a handed socket when it has one, says so,
 * and on a code move hands its own socket to a fresh process from the moved tree before it stops accepting.
 */
const SERVER = `import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const [modules, board, report] = JSON.parse(process.argv[2]);
const { serveApi } = await import(modules.api);
const { restartOnCodeMove, catchListeners, inheritedListener, announceListening, spawnOnSocket } = await import(modules.drive);
const { openBoardForRead } = await import(modules.store);
const { openCellBoard } = await import(modules.cell);
const here = fileURLToPath(new URL('.', import.meta.url));
const viewPorts = Object.fromEntries(['projectState', 'activeViewAgents', 'viewProofSummary', 'compactItemSummaries', 'viewFlowSummary'].map((name) => [name, () => null]));
const inherited = inheritedListener();
const listening = await catchListeners(() => serveApi({ port: inherited ?? 0, secret: 'fixture-secret', runCommand: async () => 0, isMain: false, viewPorts,
  projects: () => [{ root: board, name: 'fixture', project: 'fixture', added: '2026-11-12' }],
  refusalDocument: (error) => ({ error: { code: error.code ?? 'INTERNAL', message: String(error.message) } }),
  boardOpeners: { openBoard: openCellBoard, openBoardForRead, moveArgs: (body) => [body.verb] } }));
const api = listening.value;
if (inherited) announceListening();
const socket = listening.socketFd(api.port);
const revision = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: here, encoding: 'utf8' }).trim();
await fetch(report, { method: 'POST', body: JSON.stringify({ pid: process.pid, port: api.port, commit: revision() }) });
const fresh = restartOnCodeMove({ root: here, revision, close: () => listening.drain(api.port).then(api.close), interval: 100, handoff: socket !== null, log: () => {},
  relaunch: () => spawnOnSocket(process.execPath, process.argv.slice(1), { fd: socket, cwd: here, log: here + 'serve.log' }) });
await fresh.restarted;
process.exit(0);
`;

/** One GET of the board's events: its status, or the error that refused or reset it. */
function read(port, path, agent) {
  return new Promise((resolve) => {
    const call = request({ host: '127.0.0.1', port, path, agent, timeout: 10_000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    call.on('error', (error) => resolve(`ERR ${error.code ?? error.message}`));
    call.on('timeout', () => call.destroy(new Error('timeout')));
    call.end();
  });
}

/** A loopback listener each served process reports its start to; next() answers the next report: pid, port, commit. */
async function startReports(t) {
  const queued = [], waiting = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => { res.end(); const report = JSON.parse(body); const wake = waiting.shift(); if (wake) wake(report); else queued.push(report); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); server.closeAllConnections(); });
  return { url: `http://127.0.0.1:${server.address().port}/`, next: () => (queued.length ? Promise.resolve(queued.shift()) : new Promise((done) => waiting.push(done))) };
}

test('clause 1: continuous requests across a code-change restart are every one answered, none refused or reset [C7]', { timeout: 120_000 }, async (t) => {
  if (process.platform === 'win32') { t.skip('Windows hands no listening descriptor; serve restarts there as before'); return; }
  const project = cellProject(t, { real: true });
  const opened = openCellBoard(project.boardFile);
  let id;
  try { id = boardId(opened); } finally { closeCellBoard(opened); }
  const code = cellRepo(t, { real: true });
  code.put('server.mjs', SERVER);
  code.put('served.mjs', 'export const version = 1;\n');
  code.commitAll();
  const url = (path) => new URL(path, import.meta.url).href;
  const modules = { api: url('../../index.js'), drive: url('../../../drive/index.js'), store: url('../../../store/index.js'), cell: url('../../../store/tests/fixtures/cell.js') };
  const reports = await startReports(t);
  const first = startServedNode(join(code.root, 'server.mjs'), JSON.stringify([modules, project.repo, reports.url]), code.root);
  const pids = new Set([first.pid]);
  t.after(() => { for (const pid of pids) { try { process.kill(pid); } catch { /* It already exited. */ } } });
  const firstExit = once(first, 'exit');
  const { port } = await Promise.race([reports.next(), firstExit.then(([code]) => { throw new Error(`the first server exited ${code}`); })]);
  const path = `/api/v1/boards/${id}/events?k=fixture-secret`;
  // Three clients, as runners are: two open a connection per request, one keeps its connections alive.
  const replies = [], counts = [];
  let running = true;
  const reached = (count) => (replies.length >= count ? Promise.resolve() : new Promise((done) => counts.push({ count, done })));
  const keepAlive = new Agent({ keepAlive: true, maxSockets: 2 });
  t.after(() => keepAlive.destroy());
  const client = async (agent) => {
    while (running) {
      replies.push(await read(port, path, agent));
      for (const wait of counts.filter((one) => replies.length >= one.count)) { counts.splice(counts.indexOf(wait), 1); wait.done(); }
    }
  };
  const clients = [client(false), client(keepAlive), client(false)];
  await reached(20);
  // The landing: a module the server's tree holds changes, so the served process restarts on the new commit.
  code.put('served.mjs', 'export const version = 2;\n');
  const moved = code.commitAll();
  const second = await reports.next();
  pids.add(second.pid);
  await firstExit;
  const exitedAt = replies.length;
  await reached(exitedAt + 30);
  running = false;
  await Promise.all(clients);
  const failed = replies.filter((reply) => reply !== 200);
  assert.deepEqual(failed, [], `every one of ${replies.length} requests through the restart was answered`);
  assert.notEqual(second.pid, first.pid, 'a fresh process serves after the restart');
  assert.equal(second.port, port, 'the fresh process answers on the same port');
  assert.equal(second.commit, moved, 'the fresh process runs the moved code');
  assert.ok(replies.length > exitedAt, 'requests after the old process exited were answered by the new one');
});

test('clause 1: a handoff restart starts the new process before the old one stops accepting [C7]', async (t) => {
  const order = [];
  let revision = 'a'.repeat(40);
  const fresh = restartOnCodeMove({ root: '.', revision: () => revision, interval: 5, drain: 1_000, handoff: true, log: () => {},
    close: async () => { order.push('close'); }, relaunch: async () => { order.push('relaunch'); return { pid: 1, listening: true }; } });
  const hold = setInterval(() => {}, 1_000); // the watcher's timer is unref'd; this test holds the loop open
  t.after(() => { clearInterval(hold); fresh.stop(); });
  revision = 'b'.repeat(40);
  const moved = await fresh.restarted;
  assert.deepEqual(order, ['relaunch', 'close'], 'the new process listens first');
  assert.equal(moved.pid, 1);
});

test('clause 1: a new process that never listens leaves the old one serving [C7]', async (t) => {
  let closed = 0, relaunched = 0, revision = 'a'.repeat(40), said;
  const gaveUp = new Promise((done) => { said = done; });
  const fresh = restartOnCodeMove({ root: '.', revision: () => revision, interval: 5, drain: 1_000, handoff: true,
    log: (line) => { if (line.includes('never listened')) said(); },
    close: async () => { closed++; }, relaunch: async () => { relaunched++; return { pid: 2, listening: false }; } });
  const hold = setInterval(() => {}, 1_000);
  t.after(() => { clearInterval(hold); fresh.stop(); });
  revision = 'b'.repeat(40);
  await gaveUp;
  assert.equal(closed, 0, 'the old process never stopped accepting');
  assert.equal(relaunched, 1, 'it waits for the next move before trying again');
});
