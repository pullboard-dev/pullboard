/** Fixture requests reach a live server even after the test blocked its own event loop past keep-alive [C7]. */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { serveApi } from '../src/api.js';
import { main } from '../src/cli.js';
import { fetchFresh } from './http-fixture.js';

const BIN = resolve(import.meta.dirname, '../bin/pullboard.js');
/** Longer than the 5 s keep-alive the view and API servers inherit from node:http. */
const BLOCKED_MS = 6_000;

/** Block this event loop the way a synchronous CLI child does, without spending CPU on it. */
function blockEventLoop(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Build a private initialized board with its own home, so the view serves only this fixture. */
function privateBoard(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-http-fixture-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  const home = join(dir, 'home');
  mkdirSync(root);
  mkdirSync(home);
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root, env });
  const init = spawnSync(process.execPath, [BIN, 'init', '--json'], { cwd: root, env, encoding: 'utf8' });
  assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);
  return { root, env };
}

/** Start the real view as a child process, stop it with the test, and return its origin and key. */
async function startView(t, box) {
  const child = spawn(process.execPath, [BIN, 'view', '--no-open', '--port', '0', '--json'], {
    cwd: box.root, env: box.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await closed;
  });
  let stdout = '';
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (part) => { stderr += part; });
  const document = await new Promise((ready, fail) => {
    const timer = setTimeout(() => fail(new Error(`view printed no address within 30 s: ${stderr}`)), 30_000);
    child.stdout.setEncoding('utf8').on('data', (part) => {
      stdout += part;
      try { ready(JSON.parse(stdout)); clearTimeout(timer); }
      catch { /* Wait until the one JSON document is complete. */ }
    });
    child.once('close', (code) => { clearTimeout(timer); fail(new Error(`view exited ${code} before printing its address: ${stderr}`)); });
  });
  const url = new URL(document.url);
  return { origin: url.origin, key: url.searchParams.get('k') };
}

test('[C7] each fixture request opens its own connection, and a failed one names its socket error', async (t) => {
  const sockets = [];
  const connection = [];
  const server = createServer((req, res) => {
    sockets.push(req.socket);
    connection.push(req.headers.connection);
    res.end('ok');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { if (server.listening) { server.closeAllConnections(); server.close(); } });
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (let index = 0; index < 3; index += 1) assert.equal(await (await fetchFresh(`${origin}/`)).text(), 'ok');
  assert.deepEqual(connection, ['close', 'close', 'close'], 'every request asks the server to close its connection');
  assert.equal(new Set(sockets).size, 3, 'no request reuses a pooled connection');

  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await assert.rejects(fetchFresh(`${origin}/api/v1/boards?k=fixture-secret`), (error) => {
    assert.match(error.message, /^GET \/api\/v1\/boards failed: TypeError: fetch failed <- ECONNREFUSED: /u);
    assert.doesNotMatch(error.message, /fixture-secret/u, 'the request key stays out of the failure');
    assert.ok(error instanceof TypeError, 'the failure keeps the shape fetch gives it');
    assert.equal(error.cause?.code, 'ECONNREFUSED', 'its cause still carries the socket error code');
    return true;
  });
});

test('[C7] a fixture request after a blocked event loop reaches the view child and the in-process API', async (t) => {
  const box = privateBoard(t);
  const view = await startView(t, box);
  const api = await serveApi({ runCommand: main, projects: () => [{ root: box.root, name: 'HTTP fixture' }] });
  t.after(() => api.close());
  const apiUrl = new URL(api.url);
  const servers = [['the view child', view.origin, view.key], ['the in-process API', apiUrl.origin, apiUrl.searchParams.get('k')]];
  /** List boards from each live server, as the suite's live-server requests do. */
  async function listBoards(when) {
    for (const [name, origin, key] of servers) {
      const response = await fetchFresh(`${origin}/api/v1/boards`, { headers: { 'x-pullboard-key': key } });
      assert.equal(response.status, 200, `${name} answers ${when}`);
      assert.ok(Array.isArray((await response.json()).boards), `${name} returns its board listing ${when}`);
    }
  }
  // Two rounds first: with a pooled connection, the second round leaves an idle socket to reuse.
  await listBoards('before the stall');
  await listBoards('before the stall, again');
  blockEventLoop(BLOCKED_MS);
  await assert.doesNotReject(
    listBoards(`after a ${BLOCKED_MS / 1000} s blocked event loop`),
    'fresh connections still reach both servers after a blocked event loop',
  );
});
