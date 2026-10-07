/** Actual browser/device HTTP contracts, cookie isolation and mutation CSRF protection [H8, H1]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGitHubClient } from '../relay/github.js';
import { createRelayAuth } from '../relay/auth.js';
import { createAuthHandler } from '../relay/auth-http.js';
import { githubFixture } from './relay-fixture.js';

/** Start the real auth HTTP handler on loopback with a private SQLite auth store. */
async function relay(t) {
  const provider = await githubFixture(t);
  const root = mkdtempSync(join(tmpdir(), 'pullboard-relay-http-'));
  let handler;
  const server = createServer(async (req, res) => {
    if (await handler(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<title>Relay test</title><p>Signed in.</p>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const github = createGitHubClient({ ...provider.config, callbackURL: origin + '/auth/github/callback' });
  let time = Date.now();
  const auth = createRelayAuth({ database: join(root, 'auth.sqlite'), github, now: () => time });
  handler = createAuthHandler({ auth, publicOrigin: origin });
  t.after(() => { server.closeAllConnections(); server.close(); auth.close(); rmSync(root, { recursive: true, force: true }); });
  return { ...provider, origin, auth, advance(ms) { time += ms; } };
}

/** Follow the real browser redirects while keeping flow cookies out of request URLs. */
async function browserLogin(box) {
  const start = await fetch(box.origin + '/auth/github/start', { redirect: 'manual' });
  const binding = start.headers.getSetCookie()[0].split(';')[0];
  assert.match(start.headers.getSetCookie()[0], /HttpOnly; SameSite=Lax/);
  const grant = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const callbackURL = grant.headers.get('location');
  const callback = await fetch(callbackURL, { redirect: 'manual', headers: { cookie: binding } });
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get('location'), '/');
  assert.equal(callback.headers.get('cache-control'), 'no-store');
  const cookie = callback.headers.getSetCookie().find(value => value.startsWith('pb_session='));
  assert.match(cookie, /HttpOnly; SameSite=Lax/);
  return { cookie: cookie.split(';')[0], callbackURL, binding };
}

test('web redirects create HttpOnly sessions; replay and cross-origin cookie writes are refused [H8, H1]', async (t) => {
  const box = await relay(t);
  const signed = await browserLogin(box);
  const session = await fetch(box.origin + '/auth/session', { headers: { cookie: signed.cookie } });
  const principal = await session.json();
  assert.equal(principal.version, 1);
  assert.equal(principal.session.user.id, '7');
  assert.equal(principal.session.token, undefined);
  const replay = await fetch(signed.callbackURL, { redirect: 'manual', headers: { cookie: signed.binding } });
  assert.equal((await replay.json()).error.code, 'OAUTH_STATE');
  const input = { board: 'alpha', repository: 'fixture/repository' };
  const denied = await fetch(box.origin + '/auth/boards/link', { method: 'POST', headers: { cookie: signed.cookie, origin: 'https://foreign.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'BAD_ORIGIN');
  const linked = await fetch(box.origin + '/auth/boards/link', { method: 'POST', headers: { cookie: signed.cookie, origin: box.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  assert.equal(linked.status, 200);
  assert.equal((await linked.json()).board.id, 'alpha');
});

test('CLI device HTTP flow returns a one-time session and individually revocable board token [H8, H1]', async (t) => {
  const box = await relay(t);
  const start = await fetch(box.origin + '/auth/device/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const grant = await start.json();
  assert.equal(grant.version, 1);
  assert.equal(grant.deviceCode, undefined);
  await fetch(grant.verificationURL);
  box.advance(grant.interval * 1000);
  const poll = await fetch(box.origin + '/auth/device/poll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket: grant.ticket }) });
  const signed = await poll.json();
  assert.equal(signed.user.id, '7');
  assert.equal(poll.headers.get('cache-control'), 'no-store');
  const headers = { authorization: 'Bearer ' + signed.token, 'Content-Type': 'application/json' };
  const link = await fetch(box.origin + '/auth/boards/link', { method: 'POST', headers, body: JSON.stringify({ board: 'alpha', repository: 'fixture/repository' }) });
  assert.equal(link.status, 200);
  const issue = await fetch(box.origin + '/auth/tokens', { method: 'POST', headers, body: JSON.stringify({ board: 'alpha', agent: 'worker' }) });
  assert.equal(issue.status, 201);
  const scoped = await issue.json();
  const boards = await fetch(box.origin + '/auth/boards', { headers: { authorization: 'Bearer ' + scoped.token } });
  assert.equal((await boards.json()).boards.length, 1);
  const revoke = await fetch(box.origin + '/auth/tokens/revoke', { method: 'POST', headers, body: JSON.stringify({ id: scoped.id }) });
  assert.equal((await revoke.json()).revoked, true);
  const revoked = await fetch(box.origin + '/auth/boards', { headers: { authorization: 'Bearer ' + scoped.token } });
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).error.code, 'AUTH_REQUIRED');
});

test('HTTP errors are versioned and bounded; production cookies are Secure [H8, H1]', async (t) => {
  const box = await relay(t);
  const malformed = await fetch(box.origin + '/auth/device/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[' });
  const error = await malformed.json();
  assert.equal(error.version, 1);
  assert.deepEqual(Object.keys(error.error).sort(), ['code', 'message', 'next']);
  assert.equal(error.error.code, 'BAD_REQUEST');
  const tooLarge = await fetch(box.origin + '/auth/device/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ padding: 'x'.repeat(17_000) }) });
  assert.equal((await tooLarge.json()).error.code, 'BAD_REQUEST');
  let captured;
  const secureHandler = createAuthHandler({ auth: box.auth, publicOrigin: 'https://relay.example.invalid' });
  await secureHandler({ method: 'GET', url: '/auth/github/start', headers: {} }, { writeHead(status, headers) { captured = headers; }, end() {} });
  assert.match(captured['Set-Cookie'], /; Secure$/);
  assert.throws(() => createAuthHandler({ auth: box.auth, publicOrigin: 'http://relay.example.invalid' }), { code: 'RELAY_CONFIG' });
});

test('plain public readers receive the exact missing-board HTTP refusal [H13,H14,H8]', async (t) => {
  const box = await relay(t);
  box.state.public = true;
  const signed = await browserLogin(box);
  const headers = { cookie: signed.cookie, origin: box.origin, 'Content-Type': 'application/json' };
  const linked = await fetch(box.origin + '/auth/boards/link', { method: 'POST', headers, body: JSON.stringify({ board: 'alpha', repository: 'fixture/repository' }) });
  assert.equal(linked.status, 200);
  box.state.permission = 'none';
  const known = await fetch(box.origin + '/auth/tokens', { method: 'POST', headers, body: JSON.stringify({ board: 'alpha', agent: 'worker' }) });
  const absent = await fetch(box.origin + '/auth/tokens', { method: 'POST', headers, body: JSON.stringify({ board: 'missing', agent: 'worker' }) });
  assert.equal(known.status, 404);
  assert.equal(absent.status, 404);
  assert.deepEqual(await known.json(), await absent.json());
  const visible = await fetch(box.origin + '/auth/boards', { headers: { cookie: signed.cookie } });
  assert.deepEqual((await visible.json()).boards, []);
});
