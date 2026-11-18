/** Cached relay grants and refusals retain their ten-minute GitHub boundary [H21,H8]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ACCESS_WINDOW_MS } from '../index.js';
import { createRelayAuth } from '../index.js';
import { createAuthHandler } from '../index.js';
import { createGitHubClient } from '../index.js';
import { githubFixture } from '../../cli/tests/fixtures/relay.js';

/** Exercise real OAuth, GitHub HTTP, SQLite auth and public write routes with only the auth clock controlled. */
async function cachedAccessFixture(t) {
  const provider = await githubFixture(t);
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-cached-access-'));
  let current = Date.now();
  const auth = createRelayAuth({ database: join(directory, 'auth.sqlite'), github: createGitHubClient(provider.config), now: () => current });
  const server = createServer(createAuthHandler({ auth, publicOrigin: 'http://127.0.0.1' }));
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(done => server.close(done));
    auth.close();
    rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const flow = await auth.beginDevice();
  await fetch(flow.verificationURL);
  current += flow.interval * 1000;
  const person = await auth.pollDevice(flow.ticket);
  const board = 'a'.repeat(32);

  /** Return public status and nonsecret authorization fields, never bearer values in assertions. */
  async function request(method, path, value) {
    const response = await fetch(origin + path, { method, headers: {
      Authorization: 'Bearer ' + person.token, 'Content-Type': 'application/json',
    }, ...(value ? { body: JSON.stringify(value) } : {}) });
    const body = await response.json();
    return { status: response.status, error: body.error?.code, permission: body.session?.permission };
  }

  assert.equal((await request('POST', '/auth/boards/link', { board, repository: 'fixture/repository' })).status, 200);
  return {
    provider,
    advance(ms) { current += ms; },
    checks() { return provider.calls.filter(call => call.path === '/repos/fixture/repository/collaborators/fixture-user/permission').length; },
    write(agent) { return request('POST', '/auth/tokens', { board, agent }); },
    read() { return request('GET', '/auth/session?board=' + board); },
  };
}

test('relay.access.a-cached-write-grant-survives-9: a cached write grant survives 9:59 and observes revocation at 10:00 [H21,H8]', async t => {
  const box = await cachedAccessFixture(t);
  assert.equal((await box.write('grant-start')).status, 201);
  const checked = box.checks();
  box.provider.state.access = false;
  box.advance(ACCESS_WINDOW_MS - 1000);
  assert.equal((await box.write('grant-nine-fifty-nine')).status, 201);
  assert.equal(box.checks(), checked, 'a still-live write grant does not ask GitHub again');
  box.advance(1000);
  const revoked = await box.write('grant-ten-minutes');
  assert.equal(revoked.status, 403);
  assert.equal(revoked.error, 'NO_REPO_ACCESS');
  assert.equal(box.checks(), checked + 1, 'the exact boundary refreshes the revoked repository role');
});

test('relay.access.cached-negative-writes-do-not-query: cached negative writes do not query GitHub until their ten-minute window expires [H21,H8]', async t => {
  const box = await cachedAccessFixture(t);
  assert.equal((await box.write('denial-seed')).status, 201);
  box.advance(ACCESS_WINDOW_MS);
  box.provider.state.access = false;
  const denied = await box.write('denial-start');
  assert.equal(denied.status, 403);
  assert.equal(denied.error, 'NO_REPO_ACCESS');
  const checked = box.checks();
  box.provider.state.access = true;
  const immediate = await box.write('denial-immediate');
  assert.equal(box.checks(), checked, 'a cached negative write must not requery GitHub');
  assert.equal(immediate.status, 403);
  assert.equal(immediate.error, 'NO_REPO_ACCESS');
  box.advance(ACCESS_WINDOW_MS - 1000);
  const cached = await box.write('denial-nine-fifty-nine');
  assert.equal(cached.status, 403);
  assert.equal(cached.error, 'NO_REPO_ACCESS');
  assert.equal(box.checks(), checked);
  box.advance(1000);
  assert.equal((await box.write('denial-expired')).status, 201);
  assert.equal(box.checks(), checked + 1, 'expiry permits exactly one fresh authorization check');
});

test('relay.access.a-cached-readable-role-cannot-authorize: a cached readable role cannot authorize a write [H21,H8]', async t => {
  const box = await cachedAccessFixture(t);
  assert.equal((await box.write('readable-seed')).status, 201);
  box.advance(ACCESS_WINDOW_MS);
  box.provider.state.permission = 'read';
  const readable = await box.read();
  assert.equal(readable.status, 200);
  assert.equal(readable.permission, 'read');
  const checked = box.checks();
  const refused = await box.write('readable-cannot-write');
  assert.equal(refused.status, 403);
  assert.equal(refused.error, 'WRITE_REQUIRED');
  assert.equal(box.checks(), checked, 'a cached readable role refuses writes without another provider lookup');
  assert.equal((await box.read()).permission, 'read');
  assert.equal(box.checks(), checked);
});
