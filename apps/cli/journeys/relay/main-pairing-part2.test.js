/** Relay identity, expiry, permission freshness and scoped credential isolation [H8, H1]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { VERIFIER_STANDING_ENGINE } from '../../../../packages/state/index.js';
import { createGitHubClient } from '../../../relay/index.js';
import { createRelayAuth } from '../../../relay/index.js';
import { ACCESS_WINDOW_MS } from '../../../relay/index.js';
import { serveRelay } from '../../../relay/index.js';
import { fixture } from '../../tests/fixtures/relay/auth.js';
import { login } from '../../tests/fixtures/relay/auth.js';

test('lost GitHub access takes effect at ten minutes for reads and writes alike, and GitHub is asked once per window, never per write [H8, H1, H21]', async (t) => {
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
  box.advance(ACCESS_WINDOW_MS); // A denied grant is cached for the same window as an allowed grant [H21].
  await box.auth.authenticate(signed.token, { board: 'alpha', write: true });
  const asked = () => box.calls.filter(call => call.path.endsWith('/permission')).length;
  const before = asked();
  for (let write = 0; write < 5; write += 1) await box.auth.authenticate(signed.token, { board: 'alpha', write: true });
  assert.equal(asked(), before, 'writes inside the window reuse the grant instead of asking GitHub each time');
  box.state.access = false;
  box.advance(ACCESS_WINDOW_MS - 1);
  await box.auth.authenticate(signed.token, { board: 'alpha', write: true });
  box.advance(1);
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'NO_REPO_ACCESS' }, 'revoked access refuses writes once the window ends');
  assert.deepEqual(await box.auth.boardsFor(signed.token), [], 'a denied write invalidates an earlier allowed read');
  box.state.access = true;
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha' }), { code: 'NO_REPO_ACCESS' }, 'a read reuses the denial inside its window');
  await assert.rejects(box.auth.authenticate(signed.token, { board: 'alpha', write: true }), { code: 'NO_REPO_ACCESS' }, 'a write also reuses the denial inside its window');
  box.advance(ACCESS_WINDOW_MS);
  assert.equal((await box.auth.authenticate(signed.token, { board: 'alpha', write: true })).user.id, signed.user.id, 'the next window checks restored access again');
});

test('person token management lists only owned scoped metadata and preserves independent revocation [H2,H9]', async (t) => {
  const box = await fixture(t);
  const person = await login(box);
  await box.auth.linkBoard(person.token, 'alpha', 'fixture/repository');
  await box.auth.linkBoard(person.token, 'beta', 'fixture/repository-2'); // one team board per repository [E12]
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
  box.advance(ACCESS_WINDOW_MS); // A role change takes effect when the cached grant's window ends [H8,H21].
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
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${person.token}`, 'content-type': 'application/json' },
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
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
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
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${person.token}` },
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
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${person.token}`, 'content-type': 'application/json' },
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
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${person.token}`, 'content-type': 'application/json' },
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
    headers: { 'x-pullboard-engine': String(VERIFIER_STANDING_ENGINE), authorization: `Bearer ${observer.token}` },
  });
  assert.equal(current.status, 200);
  const saved = await current.json();
  assert.equal(saved.state.sequence, 0);
  assert.equal(saved.state.sealed, 'AQ', 'the snapshot uploaded before revocation remains the latest snapshot');
});
