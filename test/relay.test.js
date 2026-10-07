/** Relay identity, expiry, permission freshness and scoped credential isolation [H8, H1]. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createGitHubClient } from '../relay/github.js';
import { createRelayAuth, ACCESS_WINDOW_MS } from '../relay/auth.js';
import { serveRelay } from '../relay/service.js';
import { githubFixture } from './relay-fixture.js';

/** Use real private SQLite and an actual HTTP provider with a controllable expiry clock. */
async function fixture(t, options = {}) {
  const provider = await githubFixture(t);
  const root = mkdtempSync(join(tmpdir(), 'pullboard-relay-auth-'));
  const database = join(root, 'auth.sqlite');
  let time = Date.now();
  const clock = () => time;
  const github = createGitHubClient(provider.config);
  const config = { database, github, now: clock, ...options };
  const auth = createRelayAuth(config);
  t.after(() => { auth.close(); rmSync(root, { recursive: true, force: true }); });
  return { ...provider, providerConfig: provider.config, auth, database, config, advance(ms) { time += ms; } };
}

/** Complete a real stand-in device grant, advancing only the injected relay expiry clock. */
async function login(box) {
  const grant = await box.auth.beginDevice();
  box.state.deviceAuthorized = true;
  box.advance(grant.interval * 1000);
  return box.auth.pollDevice(grant.ticket);
}

test('browser state/cookie binding and one-use device ticket protect both sign-in flows [H8, H1]', async (t) => {
  const box = await fixture(t);
  const web = box.auth.beginWeb();
  const authorized = await fetch(web.authorizationURL, { redirect: 'manual' });
  const callback = new URL(authorized.headers.get('location'));
  const state = callback.searchParams.get('state');
  const code = callback.searchParams.get('code');
  await assert.rejects(box.auth.finishWeb(state, code, 'wrong-browser'), { code: 'OAUTH_STATE' });
  const signed = await box.auth.finishWeb(state, code, web.binding);
  assert.equal((await box.auth.authenticate(signed.token)).user.id, '7');
  await assert.rejects(box.auth.finishWeb(state, code, web.binding), { code: 'OAUTH_STATE' });
  const grant = await box.auth.beginDevice();
  assert.equal(grant.deviceCode, undefined);
  const polls = box.calls.filter(call => call.path === '/login/oauth/access_token').length;
  assert.equal((await box.auth.pollDevice(grant.ticket)).pending, true);
  assert.equal(box.calls.filter(call => call.path === '/login/oauth/access_token').length, polls);
  box.advance(1000);
  box.state.slow = true;
  assert.equal((await box.auth.pollDevice(grant.ticket)).retryAfter, 6);
  box.advance(6000);
  box.state.deviceAuthorized = true;
  const cli = await box.auth.pollDevice(grant.ticket);
  assert.equal((await box.auth.authenticate(cli.token)).user.id, '7');
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' });
});

test('unreadable links are refused; agent tokens belong to exactly one board [H8, H1]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  box.state.access = false;
  await assert.rejects(box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository'), { code: 'NO_REPO_ACCESS' });
  assert.deepEqual(await box.auth.boardsFor(signed.token), []);
  box.state.access = true;
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  await box.auth.linkBoard(signed.token, 'beta', 'fixture/repository');
  const agent = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker-1' });
  assert.equal((await box.auth.authenticate(agent.token, { board: 'alpha', write: true })).agent, 'worker-1');
  const before = box.calls.length;
  await assert.rejects(box.auth.authenticate(agent.token, { board: 'beta', write: true }), { code: 'TOKEN_BOARD' });
  assert.equal(box.calls.length, before, 'cross-board credentials are rejected before a provider check');
  assert.deepEqual((await box.auth.boardsFor(agent.token)).map(board => board.id), ['alpha']);
  await assert.rejects(box.auth.linkBoard(agent.token, 'gamma', 'fixture/repository'), { code: 'HUMAN_REQUIRED' });
});

test('lost GitHub read access takes effect at ten minutes and before every board write [H8, H1]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  await box.auth.authenticate(signed.token, { board: 'alpha' });
  box.state.access = false;
  box.advance(ACCESS_WINDOW_MS - 1);
  assert.equal((await box.auth.boardsFor(signed.token)).length, 1, 'cached reads last less than ten minutes');
  box.advance(1);
  assert.deepEqual(await box.auth.boardsFor(signed.token), []);
  box.state.access = true;
  await box.auth.authenticate(signed.token, { board: 'alpha', write: true });
  box.state.access = false;
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'NO_REPO_ACCESS' });
  assert.deepEqual(await box.auth.boardsFor(signed.token), [], 'a denied write invalidates an earlier allowed read');
});

test('credentials are hash-only, expire, revoke individually and survive relay restart [H8, H1]', async (t) => {
  const box = await fixture(t, { sessionTTL: 30_000 });
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  const first = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'one', expiresIn: 10_000 });
  const second = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'two', expiresIn: 20_000 });
  assert.notEqual(first.token, second.token);
  await box.auth.revoke(signed.token, first.id);
  await assert.rejects(box.auth.authenticate(first.token, { board: 'alpha' }), { code: 'AUTH_REQUIRED' });
  assert.equal((await box.auth.authenticate(second.token, { board: 'alpha' })).agent, 'two');
  const persisted = readFileSync(box.database);
  for (const secret of [signed.token, first.token, second.token, box.providerConfig.privateKey, box.providerConfig.clientSecret, ...box.userTokens, ...box.installationTokens].filter(Boolean)) {
    assert.ok(!persisted.includes(Buffer.from(secret)), 'plaintext credential is absent from real SQLite bytes');
  }
  box.auth.close();
  const userCalls = box.calls.filter(call => call.path === '/user').length;
  const restarted = createRelayAuth({ ...box.config, github: createGitHubClient(box.providerConfig) });
  t.after(() => restarted.close());
  assert.equal((await restarted.authenticate(signed.token, { board: 'alpha', write: true })).user.id, '7');
  assert.equal(box.calls.filter(call => call.path === '/user').length, userCalls, 'restart requires no new sign-in or user credential');
  await assert.rejects(restarted.authenticate(first.token, { board: 'alpha' }), { code: 'AUTH_REQUIRED' });
  box.advance(20_000);
  await assert.rejects(restarted.authenticate(second.token, { board: 'alpha' }), { code: 'AUTH_REQUIRED' });
  box.advance(10_000);
  await assert.rejects(restarted.authenticate(signed.token), { code: 'AUTH_REQUIRED' });
});

test('revoking during an awaited GitHub write check refuses the pending write [H8, H1]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  box.state.beforePermission = async () => { entered(); await held; };
  const pending = box.auth.authenticate(signed.token, { board: 'alpha', write: true });
  await started;
  await box.auth.revoke(signed.token, signed.id);
  release();
  await assert.rejects(pending, { code: 'AUTH_REQUIRED' });
});

test('revoking a board credential while its upload body is open stores nothing [H8, A4, H7]', async (t) => {
  const box = await fixture(t);
  const person = await login(box);
  const board = 'b'.repeat(32);
  await box.auth.linkBoard(person.token, board, 'fixture/repository');
  const agent = await box.auth.issueToken(person.token, { board, agent: 'revoked-during-upload' });
  const service = await serveRelay({
    directory: join(dirname(box.database), 'journal'), auth: box.auth, port: 0,
    publicOrigin: 'http://127.0.0.1:44444', maintenanceMs: 0,
  });
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.port}`;
  const snapshot = await fetch(`${origin}/api/v1/boards/${board}/state`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${person.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: 0, sealed: 'AQ' }),
  });
  assert.equal(snapshot.status, 200);

  let firstAuthenticationComplete;
  let signaled = false;
  const authenticated = new Promise((resolve) => { firstAuthenticationComplete = resolve; });
  const authenticate = box.auth.authenticate;
  box.auth.authenticate = async (...args) => {
    const result = await authenticate(...args);
    if (!signaled && args[1]?.board === board) {
      signaled = true;
      firstAuthenticationComplete();
    }
    return result;
  };
  let stream;
  const upload = fetch(`${origin}/api/v1/boards/${board}/moves`, {
    method: 'POST',
    headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
    body: new ReadableStream({ start(controller) { stream = controller; controller.enqueue(Buffer.from('{"sequence":1,"sealed":"')); } }),
    duplex: 'half',
  });
  await authenticated;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await box.auth.revoke(person.token, agent.id);
  stream.enqueue(Buffer.from('AQ"}'));
  stream.close();

  const response = await upload;
  const refusal = await response.json();
  assert.equal(response.status, 401, JSON.stringify(refusal));
  assert.equal(refusal.error.code, 'AUTH_REQUIRED');
  const events = await fetch(`${origin}/api/v1/boards/${board}/events?after=0`, {
    headers: { authorization: `Bearer ${person.token}` },
  });
  assert.equal(events.status, 200);
  assert.deepEqual((await events.json()).events, [], 'the revoked upload never appends a move');
  assert.equal(existsSync(join(dirname(box.database), 'journal', `${board}.journal.sqlite`)), true);
});

test('revoking a person token during snapshot upload preserves the prior snapshot [H8, A4, H7]', async (t) => {
  const box = await fixture(t);
  const person = await login(box);
  const observer = await login(box);
  const board = 'c'.repeat(32);
  await box.auth.linkBoard(person.token, board, 'fixture/repository');
  const service = await serveRelay({
    directory: join(dirname(box.database), 'journal'), auth: box.auth, port: 0,
    publicOrigin: 'http://127.0.0.1:44444', maintenanceMs: 0,
  });
  t.after(() => service.close());
  const origin = `http://127.0.0.1:${service.port}`;
  const firstSnapshot = await fetch(`${origin}/api/v1/boards/${board}/state`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${person.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sequence: 0, sealed: 'AQ' }),
  });
  assert.equal(firstSnapshot.status, 200);

  let firstAuthenticationComplete;
  let signaled = false;
  const authenticated = new Promise((resolve) => { firstAuthenticationComplete = resolve; });
  const authenticate = box.auth.authenticate;
  box.auth.authenticate = async (...args) => {
    const result = await authenticate(...args);
    if (!signaled && args[1]?.board === board) {
      signaled = true;
      firstAuthenticationComplete();
    }
    return result;
  };
  let stream;
  const upload = fetch(`${origin}/api/v1/boards/${board}/state`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${person.token}`, 'content-type': 'application/json' },
    body: new ReadableStream({ start(controller) { stream = controller; controller.enqueue(Buffer.from('{"sequence":0,"sealed":"')); } }),
    duplex: 'half',
  });
  await authenticated;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await box.auth.revoke(person.token, person.id);
  stream.enqueue(Buffer.from('Ag"}'));
  stream.close();

  const response = await upload;
  const refusal = await response.json();
  assert.equal(response.status, 401, JSON.stringify(refusal));
  assert.equal(refusal.error.code, 'AUTH_REQUIRED');
  const current = await fetch(`${origin}/api/v1/boards/${board}/state`, {
    headers: { authorization: `Bearer ${observer.token}` },
  });
  assert.equal(current.status, 200);
  const saved = await current.json();
  assert.equal(saved.state.sequence, 0);
  assert.equal(saved.state.sealed, 'AQ', 'the snapshot uploaded before revocation remains the latest snapshot');
});

test('a deleted and recreated repository cannot inherit the linked board [H8, H1]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  box.state.repositoryID = 200;
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'NO_REPO_ACCESS' });
  await assert.rejects(box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository'), { code: 'BOARD_LINK_CONFLICT' });
});

test('expired browser/device grants cannot create sessions and concurrent polls consume only once [H8, H1]', async (t) => {
  const box = await fixture(t);
  const web = box.auth.beginWeb();
  const response = await fetch(web.authorizationURL, { redirect: 'manual' });
  const callback = new URL(response.headers.get('location'));
  box.advance(10 * 60_000);
  await assert.rejects(box.auth.finishWeb(callback.searchParams.get('state'), callback.searchParams.get('code'), web.binding), { code: 'OAUTH_STATE' });
  const expired = await box.auth.beginDevice();
  box.advance(expired.expiresIn * 1000);
  await assert.rejects(box.auth.pollDevice(expired.ticket), { code: 'OAUTH_EXPIRED' });
  const grant = await box.auth.beginDevice();
  box.state.deviceAuthorized = true;
  box.advance(grant.interval * 1000);
  const results = await Promise.all([box.auth.pollDevice(grant.ticket), box.auth.pollDevice(grant.ticket)]);
  assert.equal(results.filter(result => result.token).length, 1);
  assert.equal(results.filter(result => result.pending).length, 1);
  await assert.rejects(box.auth.pollDevice(grant.ticket), { code: 'OAUTH_EXPIRED' });
});

test('a public reader sees no board and cannot act, mint or revoke; refusal matches a missing board [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  box.state.public = true;
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  const existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker' });
  box.state.permission = 'none';
  let missing;
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'absent', write: true }), error => {
    missing = { code: error.code, message: error.message }; return error.code === 'BOARD_NOT_LINKED';
  });
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), error => {
    assert.deepEqual({ code: error.code, message: error.message }, missing); return true;
  });
  assert.deepEqual(await box.auth.boardsFor(signed.token), []);
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'second' }), { code: 'BOARD_NOT_LINKED' });
  await assert.rejects(box.auth.revoke(signed.token, existing.id), { code: 'BOARD_NOT_LINKED' });
  box.state.permission = 'write';
  assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha', write: true })).agent, 'worker', 'denied revocation did not alter the token');
});

test('a public triage account sees its board but cannot act, mint or revoke its tokens [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  box.state.public = true;
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  const existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker' });
  box.state.permission = 'triage';
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'WRITE_REQUIRED' });
  assert.deepEqual((await box.auth.boardsFor(signed.token)).map(board => board.id), ['alpha']);
  assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha' })).permission, 'triage');
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'second' }), { code: 'WRITE_REQUIRED' });
  await assert.rejects(box.auth.revoke(signed.token, existing.id), { code: 'WRITE_REQUIRED' });
});

test('write, maintain and admin accounts act and mint while private readers only see [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  let existing;
  for (const permission of ['write', 'maintain', 'admin']) {
    box.state.permission = permission;
    assert.equal((await box.auth.authenticate(signed.token, { board: 'alpha', write: true })).permission, permission);
    existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker' });
    assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha', write: true })).permission, permission);
    await box.auth.revoke(signed.token, existing.id);
    await assert.rejects(box.auth.authenticate(existing.token, { board: 'alpha' }), { code: 'AUTH_REQUIRED' });
  }
  box.state.permission = 'write';
  existing = await box.auth.issueToken(signed.token, { board: 'alpha', agent: 'reader' });
  box.state.permission = 'read';
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'WRITE_REQUIRED' });
  assert.equal((await box.auth.boardsFor(signed.token)).length, 1);
  assert.equal((await box.auth.authenticate(existing.token, { board: 'alpha' })).permission, 'read');
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'no' }), { code: 'WRITE_REQUIRED' });
  await assert.rejects(box.auth.revoke(signed.token, existing.id), { code: 'WRITE_REQUIRED' });
});

test('an explicit read role still hides a public board below triage [H13,H14,H8]', async (t) => {
  const box = await fixture(t);
  box.state.public = true;
  const signed = await login(box);
  await box.auth.linkBoard(signed.token, 'alpha', 'fixture/repository');
  box.state.permission = 'read';
  assert.deepEqual(await box.auth.boardsFor(signed.token), []);
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'BOARD_NOT_LINKED' });
  await assert.rejects(box.auth.issueToken(signed.token, { board: 'alpha', agent: 'worker' }), { code: 'BOARD_NOT_LINKED' });
});
