/** Check the real public module routes used by the relay browser client [H5,H16]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createRelayBrowserHandler } from '../relay/browser-page.js';

test('the HTTP-served browser module import closure includes the SSE transport asset [H5,H16]', async t => {
  const handler = createRelayBrowserHandler({ authenticate: async () => { throw new Error('public assets must not authenticate'); } });
  const server = createServer(async (request, response) => {
    try {
      if (await handler(request, response)) return;
      response.writeHead(404).end();
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolveClose => server.close(resolveClose)));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const pending = ['/relay/client.js'];
  const seen = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const response = await fetch(origin + path, { signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200, path + ' resolves through the real browser asset handler');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy') ?? '', /default-src 'none'/u);
    assert.match(response.headers.get('content-type') ?? '', /javascript/u);
    const source = await response.text();
    for (const match of source.matchAll(/\bimport\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gu)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const child = new URL(specifier, origin + path).pathname;
      assert.ok(child.startsWith('/relay/'), 'browser module imports remain inside the fixed public asset namespace');
      pending.push(child);
    }
  }
  assert.ok(seen.has('/relay/browser-stream.js'), 'the served client can fetch the SSE transport module it imports');
});
