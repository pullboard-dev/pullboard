/** Relay identity, expiry, permission freshness and scoped credential isolation [H8, H1]. */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createGitHubClient } from '../relay/github.js';
import { createRelayAuth, ACCESS_WINDOW_MS } from '../relay/auth.js';
import { serveRelay } from '../relay/service.js';
import { githubFixture } from './relay-fixture.js';
import { relayClientFixture } from './relay-client-fixture.js';

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

test('person token management lists only owned scoped metadata and preserves independent revocation [H2,H9]', async (t) => {
  const box = await fixture(t);
  const person = await login(box);
  await box.auth.linkBoard(person.token, 'alpha', 'fixture/repository');
  await box.auth.linkBoard(person.token, 'beta', 'fixture/repository');
  const first = await box.auth.issueToken(person.token, { board: 'alpha', agent: 'worker-one' });
  const second = await box.auth.issueToken(person.token, { board: 'alpha', agent: 'worker-two' });
  const other = await box.auth.issueToken(person.token, { board: 'beta', agent: 'worker-one' });
  const foreign = new DatabaseSync(box.database);
  try {
    foreign.prepare('INSERT INTO relay_users(id,login) VALUES (?,?)').run('8', 'other-person');
    foreign.prepare('INSERT INTO relay_credentials(id,hash,kind,user_id,board,agent,expires) VALUES (?,?,?,?,?,?,?)')
      .run('foreign-private-fixture', 'f'.repeat(64), 'board', '8', 'alpha', 'foreign-worker', Date.now() + 60_000);
  } finally { foreign.close(); }
  const listed = await box.auth.listTokens(person.token, 'alpha');
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((row) => row.agent), ['worker-one', 'worker-two']);
  for (const row of listed) {
    assert.deepEqual(Object.keys(row).sort(), ['agent', 'board', 'created', 'expires', 'id', 'revoked']);
    assert.equal(row.board, 'alpha');
    assert.equal(row.revoked, false);
  }
  for (const secret of [person.token, first.token, second.token, other.token]) {
    assert.equal(JSON.stringify(listed).includes(secret), false, 'listing never includes a credential value');
  }
  await assert.rejects(box.auth.listTokens(first.token, 'alpha'), { code: 'HUMAN_REQUIRED' });
  await assert.rejects(box.auth.listTokens(first.token, 'beta'), { code: 'TOKEN_BOARD' });
  await box.auth.revoke(person.token, first.id);
  assert.equal((await box.auth.listTokens(person.token, 'alpha')).find((row) => row.id === first.id).revoked, true);
  await assert.rejects(box.auth.authenticate(first.token, { board: 'alpha', write: true }), { code: 'AUTH_REQUIRED' });
  assert.equal((await box.auth.authenticate(second.token, { board: 'alpha', write: true })).agent, 'worker-two');
  assert.equal((await box.auth.authenticate(other.token, { board: 'beta', write: true })).agent, 'worker-one');
  box.state.permission = 'read';
  await assert.rejects(box.auth.listTokens(person.token, 'alpha'), { code: 'WRITE_REQUIRED' });
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

test('relay off forgets expired and independently unlinked boards while preserving local rows [H1,H7,H18]', async (t) => {
  for (const cause of ['expired', 'other-client']) await t.test(cause, async (t) => {
    const box = await relayClientFixture(t);
    await box.link();
    const localBeforeDeletion = (await box.cli('export')).document.tables;
    if (cause === 'expired') box.advance(90);
    else assert.equal(await box.otherDeviceOff(), 0, 'a second real CLI device unlinks the shared board');
    const off = await box.cli('relay', 'off');
    assert.equal(off.code, 0);
    assert.equal(off.document.linked, false);
    assert.equal(off.document.alreadyDeleted, true);
    assert.match(off.document.notice, /already deleted/);
    assert.equal(existsSync(box.linkFile), false, 'local link metadata is forgotten');
    assert.equal(existsSync(box.keyFile), false, 'device-only fallback key is forgotten');
    assert.deepEqual((await box.cli('export')).document.tables, localBeforeDeletion, 'local board is complete after remote deletion');
    const count = box.calls.length;
    assert.equal((await box.cli('relay', 'off')).code, 0);
    assert.equal((await box.cli('status')).code, 0);
    assert.equal(box.calls.length, count, 'repeated off and local commands make no relay connection');
  });
});

test('relay off retains credentials and metadata after non-missing or unsupported refusals [H1,H7]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  for (const failure of [
    { status: 403, code: 'NO_REPO_ACCESS' },
    { status: 401, code: 'AUTH_REQUIRED' },
    { status: 500, code: 'NO_BOARD' },
    { status: 404, code: 'NO_BOARD', version: 2 },
  ]) {
    box.overrideDelete(failure);
    assert.notEqual((await box.cli('relay', 'off')).code, 0, 'only a supported missing-board response permits cleanup');
    assert.equal(existsSync(box.linkFile), true);
    assert.equal(existsSync(box.keyFile), true);
  }
  box.overrideDelete(null);
  assert.equal((await box.cli('relay', 'off')).code, 0);
  assert.equal(existsSync(box.keyFile), false);
});

test('BOARD_INACTIVE appears once per command and resets for a second command in the same process [H18]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  box.advance(80);
  const result = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    const counts = [];
    for (let i = 0; i < 2; i++) {
      let output = '';
      const code = await main(['status', '--json'], {
        cwd: process.cwd(), stdout: { write(part) { output += part; } },
        stderr: { write() {} },
      });
      const value = JSON.parse(output);
      counts.push({ code, warnings: (value.diagnostics || []).filter(line => line.includes('BOARD_INACTIVE')).length });
    }
    console.log(JSON.stringify(counts));
  `);
  assert.equal(result.code, 0);
  assert.deepEqual(result.document, [{ code: 0, warnings: 1 }, { code: 0, warnings: 1 }]);
});

test('unlinked board commands attempt zero outbound requests [H1,P5]', async (t) => {
  const box = await relayClientFixture(t);
  const result = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    let attempts = 0;
    globalThis.fetch = async () => { attempts++; throw new Error('unexpected outbound attempt'); };
    const codes = [];
    for (const args of [
      ['status'], ['list'], ['show', '1'], ['add', ${JSON.stringify(box.lane)}, 'another fixture item'],
      ['shout', 'coordinator', 'fixture local message'], ['relay'], ['relay', 'off'],
    ]) codes.push(await main([...args, '--json'], {
      cwd: process.cwd(), stdout: { write() {} }, stderr: { write() {} },
    }));
    console.log(JSON.stringify({ attempts, codes }));
  `);
  assert.equal(result.code, 0);
  assert.equal(result.document.attempts, 0);
  assert.ok(result.document.codes.every(code => code === 0), 'all ordinary local board commands succeed without transport');
});

test('plain relay off explains an already-deleted board without printing credentials [H1,H18]', async (t) => {
  const box = await relayClientFixture(t);
  await box.link();
  box.advance(90);
  const result = await box.script(`
    import { main } from ${JSON.stringify(box.mainURL)};
    let output = '';
    const code = await main(['relay', 'off'], {
      cwd: process.cwd(), stdout: { write(part) { output += part; } }, stderr: { write() {} },
    });
    console.log(JSON.stringify({ code, explained: output.includes('already deleted'), credential: /ps_|key=/.test(output) }));
  `);
  assert.equal(result.code, 0);
  assert.deepEqual(result.document, { code: 0, explained: true, credential: false });
});
