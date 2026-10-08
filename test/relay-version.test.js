/** Real authenticated client version gates before opaque board records [H16,H3]. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRelayAuth } from '../relay/auth.js';
import { createGitHubClient } from '../relay/github.js';
import { serveRelay } from '../relay/service.js';
import { githubFixture } from './relay-fixture.js';

const A = 'a'.repeat(32); // no board credential has ever existed
const B = 'b'.repeat(32); // historical board credential, even after revocation

test('relay enforces the minimum engine ever required by each board [H16,H3]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-relay-version-'));
  const provider = await githubFixture(t);
  let time = Date.now();
  const authConfig = { database: join(directory, 'auth.sqlite'), github: createGitHubClient(provider.config), now: () => time };
  let auth = createRelayAuth(authConfig);
  const flow = auth.beginWeb();
  const grant = await fetch(flow.authorizationURL, { redirect: 'manual' });
  const callback = new URL(grant.headers.get('location'));
  const person = await auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), flow.binding);
  await auth.linkBoard(person.token, A, 'fixture/repository');
  await auth.linkBoard(person.token, B, 'fixture/repository');
  const historical = await auth.issueToken(person.token, { board: B, agent: 'once-issued', expiresIn: 1 });
  await auth.revoke(person.token, historical.id);
  time += 10;
  assert.equal(auth.minimumEngineVersion(A), 1);
  assert.equal(auth.minimumEngineVersion(B), 3);
  auth.close();
  auth = createRelayAuth(authConfig);
  assert.equal(auth.minimumEngineVersion(B), 3, 'the minimum survives revocation, expiry and reopening the real auth database');
  const relay = await serveRelay({ directory: join(directory, 'data'), auth, maintenanceMs: 0, pollMs: 10 });
  t.after(async () => { await relay.close(); auth.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${relay.port}/api/v1/boards/`;
  const opaque = Buffer.from('opaque-test-ciphertext').toString('base64url');
  /** Read or mutate only this private relay with an explicit client engine declaration. */
  async function call(board, path = '/state', { engine, method = 'GET', body, token = person.token, accept } = {}) {
    const headers = { authorization: `Bearer ${token}`, ...(engine === undefined ? {} : { 'x-pullboard-engine': String(engine) }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(accept ? { accept } : {}) };
    const response = await fetch(base + board + path, { method, headers, ...(body === undefined ? {} : { body }) });
    const text = await response.text();
    let document;
    try { document = JSON.parse(text); } catch { document = null; }
    return { status: response.status, text, document, response };
  }
  // Seed opaque snapshots so eligible reads reach actual state and event handlers.
  for (const board of [A, B]) {
    const seeded = await call(board, '/state', { engine: 3, method: 'PUT', body: JSON.stringify({ sequence: 0, sealed: opaque }) });
    assert.equal(seeded.status, 200, seeded.text);
  }

  for (const board of [A, B]) {
    assert.equal((await call(board, '/state', { engine: 3 })).status, 200);
    assert.equal((await call(board, '/events?after=0', { engine: 3 })).status, 200);
  }
  for (const board of [A, B]) {
    const controller = new AbortController();
    const streamed = await fetch(base + board + '/events?after=0', {
      headers: { authorization: `Bearer ${person.token}`, 'x-pullboard-engine': '3', accept: 'text/event-stream' }, signal: controller.signal,
    });
    assert.equal(streamed.status, 200);
    await streamed.body.cancel(); controller.abort();
  }

  assert.equal((await call(A, '/state', { engine: 2 })).status, 200, 'an unclaimed legacy board remains readable by engine 2');
  assert.equal((await call(A, '/events?after=0', { engine: 2 })).status, 200);
  for (const path of ['/state', '/events?after=0', '/moves', '/requests']) {
    const method = path === '/state' ? 'GET' : path.startsWith('/events') ? 'GET' : 'POST';
    const blocked = await call(B, path, { engine: 2, method, body: method === 'POST' ? 'this body must never be parsed' : undefined });
    assert.equal(blocked.status, 400, blocked.text);
    assert.equal(blocked.document?.error?.code, 'ENGINE_VERSION', blocked.text);
    assert.match(blocked.document.error.message + ' ' + (blocked.document.error.next ?? ''), /upgrade/i);
    assert.equal(blocked.text.includes(opaque), false, 'no stored ciphertext reaches the old client');
  }
  for (const [path, method] of [['/state', 'PUT'], ['', 'DELETE']]) {
    const blocked = await call(B, path, { engine: 2, method, body: method === 'PUT' ? 'not-json' : undefined });
    assert.equal(blocked.status, 400, blocked.text);
    assert.equal(blocked.document?.error?.code, 'ENGINE_VERSION', 'the version gate precedes write-body parsing or deletion');
  }
  const oldStream = await call(B, '/events?after=0', { engine: 2, accept: 'text/event-stream' });
  assert.equal(oldStream.status, 400);
  assert.equal(oldStream.document.error.code, 'ENGINE_VERSION');
  const legacyA = await call(A, '/state');
  assert.equal(legacyA.status, 200, 'missing header is legacy engine 1 where no agent was ever issued');
  const legacyB = await call(B, '/state');
  assert.equal(legacyB.document?.error?.code, 'ENGINE_VERSION');
  for (const malformed of ['2, 3', 'not-an-integer']) {
    const refused = await call(B, '/state', { engine: malformed });
    assert.equal(refused.document?.error?.code, 'ENGINE_VERSION');
  }

  // Engine 2 can still perform each supported write against the unclaimed board.
  assert.equal((await call(A, '/moves', { engine: 2, method: 'POST', body: JSON.stringify({ sequence: 1, sealed: opaque }) })).status, 200);
  assert.equal((await call(A, '/requests', { engine: 2, method: 'POST', body: JSON.stringify({ sequence: 2, sealed: opaque }) })).status, 200);
  assert.equal((await call(A, '/state', { engine: 2, method: 'PUT', body: JSON.stringify({ sequence: 2, sealed: opaque }) })).status, 200);
  const deleted = await call(A, '', { engine: 2, method: 'DELETE' });
  assert.equal(deleted.status, 200, deleted.text);

  // A new board lifetime starts at the legacy minimum; issuing a token stops its already-open old stream.
  await auth.linkBoard(person.token, A, 'fixture/repository');
  assert.equal((await call(A, '/state', { engine: 2, method: 'PUT', body: JSON.stringify({ sequence: 0, sealed: opaque }) })).status, 200);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  t.after(() => { clearTimeout(timeout); controller.abort(); });
  const live = await fetch(base + A + '/events?after=0', { headers: { authorization: `Bearer ${person.token}`, 'x-pullboard-engine': '2', accept: 'text/event-stream' }, signal: controller.signal });
  assert.equal(live.status, 200);
  const reader = live.body.getReader();
  let received = new TextDecoder().decode((await reader.read()).value);
  await auth.issueToken(person.token, { board: A, agent: 'new-agent' });
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    received += new TextDecoder().decode(part.value);
  }
  assert.match(received, /event: error/);
  assert.match(received, /ENGINE_VERSION/);
  assert.doesNotMatch(received, new RegExp(opaque), 'the now-old stream closes without returning stored records');
  clearTimeout(timeout);
});
