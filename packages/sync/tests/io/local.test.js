/** Local requests fail without undici's uncaught first-write socket option error [C7,N26]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { runFixtureChild } from "../../../../apps/cli/tests/fixtures/child.js";
import { fetchLocal } from "../../index.js";

/** Run one isolated real-socket fault without installing a global handler in the product or parent. */
function socketChild(mode, home) {
  const source = `
    import assert from 'node:assert/strict';
    import { Agent, createServer } from 'node:http';
    import { channel } from 'node:diagnostics_channel';
    import { Socket } from 'node:net';
    import { fetchLocal } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../index.js')).href)};
    import { fetchFresh } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../fixtures/http.js')).href)};
    import { rememberView, runningView } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../../../../apps/view/index.js')).href)};
    const mode = ${JSON.stringify(mode)};
    const server = createServer((_request, response) => response.end('ok'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    let firstWriteFault = false, closedBeforeWrite = false;
    process.on('uncaughtExceptionMonitor', error => {
      process.stderr.write(JSON.stringify({ event: 'uncaught', code: error.code, firstWriteFault }) + '\\n');
    });
    channel('undici:client:connected').subscribe(({ socket }) => {
      if (socket.remotePort !== port) return;
      assert.ok(socket instanceof Socket);
      socket.setTypeOfService = function () {
        firstWriteFault = true;
        assert.equal(this.bytesWritten, 0);
        this.destroy();
        throw Object.assign(new Error('controlled first-write socket-option failure'), { code: 'EINVAL' });
      };
    });
    const createConnection = Agent.prototype.createConnection;
    Agent.prototype.createConnection = function (...args) {
      const socket = createConnection.apply(this, args);
      // node:http may queue bytes before connect. Intercept the first write itself, then
      // close the connected socket without sending those queued bytes to the peer.
      socket.write = function () {
        assert.ok(socket instanceof Socket);
        assert.equal(socket.bytesWritten, 0);
        const close = () => {
          closedBeforeWrite = true;
          socket.destroy(Object.assign(new Error('controlled socket closed before first write'), { code: 'ECONNRESET' }));
        };
        if (socket.connecting) socket.once('connect', close);
        else close();
        return false;
      };
      return socket;
    };
    try {
      if (mode === 'view') {
        rememberView({ port, pid: process.pid, secret: 'local-test', boundAt: new Date().toISOString() });
        assert.equal(await runningView(port), null);
      } else {
        const transport = mode === 'native' ? fetch : mode === 'fixture' ? fetchFresh : fetchLocal;
        await assert.rejects(transport('http://127.0.0.1:' + port + '/', { signal: AbortSignal.timeout(2000) }),
          error => error instanceof TypeError && error.cause?.code === 'ECONNRESET');
      }
      assert.equal(firstWriteFault, false, 'local requests never enter the unsafe undici write path');
      assert.equal(closedBeforeWrite, true, 'the request used a real socket closed before its first write');
      process.stdout.write(JSON.stringify({ event: 'request-contained', mode, closedBeforeWrite, firstWriteFault }) + '\\n');
    } finally {
      Agent.prototype.createConnection = createConnection;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  `;
  return runFixtureChild(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', env: { ...process.env, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: home },
  });
}

test('sync.local.closed-socket-fails-request: a socket closed before the first write fails the request, not the process [C7,N26]', t => {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-local-fetch-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  // The control deliberately injects the known failure class. It does not claim to explain
  // why macOS returned EINVAL in the historical gates. Node 22 lacks this undici call.
  const bundled = process.binding('natives')['internal/deps/undici/undici'];
  if (bundled.includes('socket.setTypeOfService(request.typeOfService)')) {
    const baseline = socketChild('native', home);
    assert.equal(baseline.status, 1, 'await/catch alone cannot contain the upstream callback throw');
    assert.match(baseline.stderr, /"event":"uncaught","code":"EINVAL","firstWriteFault":true/u);
    assert.match(baseline.stderr, /at writeH1/u);
  }
  for (const mode of ['local', 'fixture', 'view']) {
    const result = socketChild(mode, home);
    assert.equal(result.status, 0, result.failure ?? result.stderr);
    assert.match(result.stdout, /"event":"request-contained"/u);
    assert.doesNotMatch(result.stderr, /"event":"uncaught"/u);
  }
});

test('sync.local.keeps-streams-and-redirects: local HTTP keeps response streams, request bodies, redirects and abort reasons [C7,N26]', async t => {
  const observed = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/hang') return;
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/echo' });
      return response.end();
    }
    if (request.url === '/outside') {
      response.writeHead(302, { location: 'https://example.invalid/' });
      return response.end();
    }
    if (request.url === '/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ready\n\n');
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    observed.push({ method: request.method, body, connection: request.headers.connection });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ body, marker: request.headers['x-marker'] ?? null }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const posted = await fetchLocal(origin + '/echo', { method: 'POST', headers: { 'x-marker': 'present' }, body: 'payload' });
  assert.equal(posted.status, 200);
  assert.deepEqual(await posted.json(), { body: 'payload', marker: 'present' });
  assert.deepEqual(observed[0], { method: 'POST', body: 'payload', connection: 'close' });
  const manual = await fetchLocal(origin + '/redirect', { redirect: 'manual' });
  assert.equal(manual.status, 302);
  await manual.body.cancel();
  const followed = await fetchLocal(origin + '/redirect', { method: 'POST', body: 'discarded' });
  assert.equal(followed.redirected, true);
  assert.deepEqual(await followed.json(), { body: '', marker: null });
  await assert.rejects(fetchLocal(origin + '/outside'), /loopback HTTP/u);
  const head = await fetchLocal(origin + '/echo', { method: 'HEAD' });
  assert.equal(await head.text(), '');
  const controller = new AbortController();
  const pending = fetchLocal(origin + '/hang', { signal: controller.signal });
  const reason = new Error('controlled local abort');
  controller.abort(reason);
  await assert.rejects(pending, error => error === reason);
  const stream = await fetchLocal(origin + '/stream');
  const reader = stream.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: ready\n\n');
  await reader.cancel();
  const bodyController = new AbortController();
  const abortableStream = await fetchLocal(origin + '/stream', { signal: bodyController.signal });
  const abortableReader = abortableStream.body.getReader();
  await abortableReader.read();
  bodyController.abort(reason);
  await assert.rejects(abortableReader.read(), error => error === reason);
  await assert.rejects(fetchLocal('https://example.invalid/'), /loopback HTTP/u);
});
