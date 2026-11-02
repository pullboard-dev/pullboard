/** The real and fake relay adapters obey the same request and response contract [C7]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { browserJSON } from '../relay/browser-deadline.js';
import { relayBoundaryProblems } from '../bin/checks/relay-boundary.js';
import { createFakeRelayAdapter, realRelayAdapter, relayFetch, withRelayAdapter } from '../packages/person/index.js';

async function contract(adapter, origin) {
  const response = await adapter.request(new URL('/echo', origin), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: 7 }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.deepEqual(await response.json(), { value: 7 });
}

test('real and fake relay transports share the request response contract [C7]', async t => {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(body);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fake = createFakeRelayAdapter((url, options) => {
    assert.equal(new URL(url).pathname, '/echo');
    assert.equal(options.method, 'POST');
    return new Response(options.body, { status: 201, headers: { 'content-type': 'application/json' } });
  });
  await contract(realRelayAdapter, origin);
  await contract(fake, origin);
});

test('scoped relay fakes stay isolated across concurrent async work [C7]', async () => {
  const fake = value => createFakeRelayAdapter(async () => {
    await Promise.resolve();
    return new Response(value);
  });
  const run = value => withRelayAdapter(fake(value), async () => (await relayFetch('http://example.test')).text());
  assert.deepEqual(await Promise.all([run('first'), run('second')]), ['first', 'second']);
});

/** Browser JSON uses the same contract without requiring Node's scoped storage. */
test('browser relay JSON accepts the shared fake contract [C7]', async () => {
  const fake = createFakeRelayAdapter(async (url, options) => {
    assert.equal(url, '/board');
    assert.equal(options.adapter, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return new Response(JSON.stringify({ version: 1 }), { headers: { 'content-type': 'application/json' } });
  });
  const result = await browserJSON('/board', { adapter: fake });
  assert.deepEqual(result.document, { version: 1 });
});

/** The source gate rejects a new direct network call while ignoring comments and fixture strings. */
test('relay lint refuses a stray direct fetch [C7]', () => {
  const rows = relayBoundaryProblems([{ file: 'src/stray-relay.js', source: 'export async function read(url) { return fetch(url); }' }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, 'src/stray-relay.js');
  assert.deepEqual(relayBoundaryProblems([{ file: 'src/fixture.js', source: 'const example = "fetch(url)"; // fetch(url)' }]), []);
});
