/** @pullboard-test-input packages/person/src/logic/enrollment.js */
/** Independent person-root enrollment and opaque account envelopes [H15]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAuthHandler } from '../../../../index.js';
import { createGitHubClient } from '../../../../index.js';
import { createRelayAuth } from '../../../../index.js';
import { createRelayHandler } from '../../../../index.js';
import { githubFixture } from '../../../../../cli/tests/fixtures/relay.js';
import {
  unwrapDeviceBoardKey,
  wrapDeviceBoardKey,
} from '../../../../../../packages/keys/index.js';
import { test } from 'node:test';
import { createDeviceKeys } from '../../../../../../packages/keys/index.js';
import { createDeviceStore } from '../../../../index.js';
import { DatabaseSync } from 'node:sqlite';

/** Load the independent verifier only after proving that the production capability exists. */
async function personAPI() {
  assert.equal(existsSync(new URL('../../../../../../packages/person/src/logic/enrollment.js', import.meta.url)), true,
    'an independent person-root verifier is required before relay enrollment can release a wrap');
  return await import('../../../../../../packages/person/light.js');
}

/** Bind the exact device key and board grants to a single person-authorized challenge. */
function request(keys, overrides = {}) {
  return { v: 1, account: '42', device: keys.deviceId, publicKey: keys.publicKey,
    origin: 'https://pullboard.example', nonce: Buffer.alloc(32, 17).toString('base64url'),
    expires: 1_800_000_060_000, grants: ['a'.repeat(32)], ...overrides };
}

test('person enrollment verifies the trusted root and exact account device origin nonce expiry grants [H15]', async () => {
  const api = await personAPI();
  const root = await api.createPersonRoot();
  const stranger = await api.createPersonRoot();
  const keys = await createDeviceKeys();
  const other = await createDeviceKeys();
  const body = request(keys);
  const expected = { account: body.account, origin: body.origin, nonce: body.nonce,
    grants: body.grants, now: 1_800_000_000_000 };
  const signed = await api.signPersonEnrollment(root.privateKey, body);
  assert.equal(root.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', root.privateKey));
  assert.equal(JSON.stringify(signed).includes('privateKey'), false);
  assert.deepEqual(await api.authenticatePersonEnrollment(root.publicKey, signed, expected), body);
  for (const changed of [
    { ...signed, publicKey: other.publicKey },
    { ...signed, device: other.deviceId },
    { ...signed, account: '43' },
    { ...signed, origin: 'https://relay-attacker.example' },
    { ...signed, nonce: Buffer.alloc(32, 18).toString('base64url') },
    { ...signed, expires: body.expires + 1 },
    { ...signed, grants: ['b'.repeat(32)] },
  ]) await assert.rejects(api.authenticatePersonEnrollment(root.publicKey, changed, expected),
    { code: 'PERSON_ENROLL_AUTH' });
  await assert.rejects(api.authenticatePersonEnrollment(stranger.publicKey, signed, expected),
    { code: 'PERSON_ENROLL_AUTH' }, 'a relay-supplied replacement trust root is not the locally trusted root');
  await assert.rejects(api.authenticatePersonEnrollment(root.publicKey, signed,
    { ...expected, now: body.expires }), { code: 'PERSON_ENROLL_EXPIRED' });
  await assert.rejects(api.authenticatePersonEnrollment(root.publicKey, signed,
    { ...expected, revoked: true }), { code: 'PERSON_ENROLL_REVOKED' });
});

test('account envelopes require independently retained key and exact account context [H15]', async () => {
  const api = await personAPI();
  const recovery = crypto.getRandomValues(new Uint8Array(32));
  const vault = crypto.getRandomValues(new Uint8Array(32));
  const context = { account: '42', keyId: 'person-root-1', revision: 1 };
  const envelope = await api.sealAccountEnvelope(recovery, vault, context);
  const again = await api.sealAccountEnvelope(recovery, vault, context);
  assert.notEqual(envelope.nonce, again.nonce);
  const serialized = JSON.stringify(envelope);
  for (const bytes of [recovery, vault]) assert.equal(serialized.includes(Buffer.from(bytes).toString('base64url')), false);
  assert.deepEqual(await api.openAccountEnvelope(recovery, envelope, context), vault);
  for (const expected of [{ ...context, account: '43' }, { ...context, revision: 2 }, { ...context, keyId: 'other-root' }]) {
    await assert.rejects(api.openAccountEnvelope(recovery, envelope, expected), { code: 'PERSON_ENVELOPE_AUTH' });
  }
  await assert.rejects(api.openAccountEnvelope(crypto.getRandomValues(new Uint8Array(32)), envelope, context),
    { code: 'PERSON_ENVELOPE_AUTH' });
  const tampered = { ...envelope, ciphertext: Buffer.alloc(48).toString('base64url') };
  await assert.rejects(api.openAccountEnvelope(recovery, tampered, context), { code: 'PERSON_ENVELOPE_AUTH' });
});

/** Start actual apps/relay/src/io/deploy/auth HTTP handlers with private SQLite and a real GitHub protocol fixture. */
async function relayDeviceFixture(t) {
  const provider = await githubFixture(t);
  const root = mkdtempSync(join(tmpdir(), 'pullboard-device-http-'));
  const relayDirectory = join(root, 'relay');
  let now = Date.now();
  let auth;
  let relay;
  let authHandler;
  const server = createServer(async (req, res) => {
    if (await authHandler(req, res)) return;
    await relay(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const githubConfig = { ...provider.config, callbackURL: origin + '/auth/github/callback' };

  /** Reopen both persistent databases as a new relay process would. */
  function restart() {
    relay?.close();
    auth?.close();
    auth = createRelayAuth({ database: join(root, 'auth.sqlite'), github: createGitHubClient(githubConfig), now: () => now });
    relay = createRelayHandler({ directory: relayDirectory, auth, publicOrigin: origin, now: () => now, maintenanceMs: 0 });
    authHandler = createAuthHandler({ auth, publicOrigin: origin });
  }
  restart();
  t.after(() => {
    server.closeAllConnections();
    server.close();
    relay?.close();
    auth?.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { ...provider, root, relayDirectory, origin, get auth() { return auth; }, advance(ms) { now += ms; }, restart };
}

/** Complete the real browser redirect flow and retain only the person session cookie. */
async function browserSession(box) {
  const start = await fetch(box.origin + '/auth/github/start', { redirect: 'manual' });
  const binding = start.headers.getSetCookie()[0].split(';')[0];
  const grant = await fetch(start.headers.get('location'), { redirect: 'manual' });
  const callback = await fetch(grant.headers.get('location'), { redirect: 'manual', headers: { cookie: binding } });
  assert.equal(callback.status, 303);
  return callback.headers.getSetCookie().find(value => value.startsWith('pb_session=')).split(';')[0];
}

/** Send one JSON request to the real relay endpoint with a bearer or browser session. */
async function deviceRequest(box, path, { method = 'GET', token, cookie, origin, body, engine } = {}) {
  const headers = {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(cookie ? { cookie } : {}),
    ...(origin ? { origin } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(engine === undefined ? {} : { 'x-pullboard-engine': String(engine) }),
  };
  const response = await fetch(box.origin + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, document: await response.json() };
}



test('a person-bound challenge gets an opaque wrap and a substituted key, wrong account, replay, expiry or revoked enrollment gets none [H15]', async (t) => {
  const api = await personAPI();
  const box = await relayDeviceFixture(t);
  const recipientCookie = await browserSession(box);
  const holderCookie = await browserSession(box);
  const root = await api.createPersonRoot();
  const recipient = await createDeviceKeys();
  const stranger = await createDeviceKeys();
  const recovery = crypto.getRandomValues(new Uint8Array(32));
  const boardKey = crypto.getRandomValues(new Uint8Array(32));
  const board = 'a'.repeat(32);
  const link = await deviceRequest(box, '/auth/boards/link', { method: 'POST', cookie: holderCookie,
    origin: box.origin, body: { board, repository: 'fixture/repository' } });
  assert.equal(link.response.status, 200);
  let nonceId = 0;
  /** Make independently signed challenges with bounded unique nonces. */
  async function challenge(keys = recipient) {
    const now = Date.now();
    return await api.signPersonEnrollment(root.privateKey, request(keys, { account: '7', origin: box.origin,
      nonce: Buffer.alloc(32, ++nonceId).toString('base64url'), expires: now + 60_000, grants: [board] }));
  }
  /** Use the real authenticated relay endpoint; plaintext keys never enter this body. */
  async function send(signed, method, body, cookie = recipientCookie) {
    return await deviceRequest(box, '/api/v1/devices/person-enrollments/' + signed.nonce,
      { method, body, cookie, origin: box.origin });
  }
  /** A key-holding client authenticates its pinned root before producing any opaque wrap. */
  async function release(signed, expected = {}) {
    const pending = await send(signed, 'GET', undefined, holderCookie);
    assert.equal(pending.response.status, 200);
    const verified = await api.authenticatePersonEnrollment(root.publicKey, pending.document.enrollment,
      { account: '7', origin: box.origin, nonce: signed.nonce, grants: [board], now: Date.now(), ...expected });
    const envelope = await wrapDeviceBoardKey(boardKey, verified.publicKey,
      { board, device: verified.device, engine: 93 });
    return await send(signed, 'PUT', { board, engine: 93,
      wrapped: Buffer.from(JSON.stringify(envelope)).toString('base64url') }, holderCookie);
  }
  const valid = await challenge();
  assert.equal((await send(valid, 'POST', valid)).response.status, 200);
  assert.equal((await release(valid)).response.status, 200);
  const delivered = await send(valid, 'GET');
  const wrapped = JSON.parse(Buffer.from(delivered.document.wraps[0].wrapped, 'base64url'));
  assert.deepEqual(await unwrapDeviceBoardKey(recipient.privateKey, wrapped,
    { board, device: recipient.deviceId, engine: 93 }), boardKey);
  await assert.rejects(unwrapDeviceBoardKey(stranger.privateKey, wrapped,
    { board, device: recipient.deviceId, engine: 93 }), { code: 'DEVICE_WRAP_AUTH' });
  assert.equal((await send(valid, 'POST', valid)).document.error.code, 'PERSON_ENROLL_REPLAY');
  assert.equal((await release(valid)).document.error.code, 'PERSON_ENROLL_REPLAY');

  const substituted = { ...await challenge(), publicKey: stranger.publicKey };
  assert.equal((await send(substituted, 'POST', substituted)).response.status, 200);
  await assert.rejects(release(substituted), { code: 'PERSON_ENROLL_AUTH' });
  assert.deepEqual((await send(substituted, 'GET')).document.wraps, []);

  box.state.accountID = 8;
  const wrongCookie = await browserSession(box);
  const wrong = await challenge();
  assert.equal((await send(wrong, 'POST', wrong, wrongCookie)).document.error.code, 'PERSON_ENROLL_ACCOUNT');
  assert.equal((await send(valid, 'GET', undefined, wrongCookie)).document.error.code, 'PERSON_ENROLL_MISSING');

  const expired = await challenge();
  assert.equal((await send(expired, 'POST', expired)).response.status, 200);
  box.advance(61_000);
  assert.equal((await send(expired, 'PUT', { board, engine: 93, wrapped: 'AAAA' }, holderCookie)).document.error.code,
    'PERSON_ENROLL_EXPIRED');
  const revoked = await challenge(stranger);
  // Challenge times remain within the relay's advanced clock for this independent refusal.
  const revokedBody = await api.signPersonEnrollment(root.privateKey,
    { ...revoked, expires: Date.now() + 120_000 });
  assert.equal((await send(revokedBody, 'POST', revokedBody)).response.status, 200);
  assert.equal((await deviceRequest(box, '/api/v1/devices/' + stranger.deviceId,
    { method: 'DELETE', cookie: holderCookie, origin: box.origin })).response.status, 200);
  assert.equal((await send(revokedBody, 'PUT', { board, engine: 93, wrapped: 'AAAA' }, holderCookie)).document.error.code,
    'PERSON_ENROLL_REVOKED');
  const sealed = await api.sealAccountEnvelope(recovery, boardKey,
    { account: '7', keyId: 'fixture-person-root', revision: 1 });
  assert.deepEqual(await api.openAccountEnvelope(recovery, sealed,
    { account: '7', keyId: 'fixture-person-root', revision: 1 }), boardKey);
  box.restart();
  const durable = await send(valid, 'GET');
  assert.equal(durable.document.wraps.length, 1);
  assert.equal((await send(valid, 'POST', valid)).document.error.code, 'PERSON_ENROLL_REPLAY');
  const database = readFileSync(join(box.relayDirectory, 'devices.sqlite'));
  for (const secret of [boardKey, recovery]) {
    assert.equal(database.includes(Buffer.from(secret)), false);
    assert.equal(database.includes(Buffer.from(Buffer.from(secret).toString('base64url'))), false);
  }
  assert.equal(JSON.stringify(delivered.document).includes('privateKey'), false);
});


/** The device schema is complete on first ordinary access, without requiring a person's enrollment traffic. */
test('cold device storage creates person enrollment schema without person traffic [H15]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-person-cold-'));
  const store = createDeviceStore({ directory });
  const file = join(directory, 'devices.sqlite');
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.equal(existsSync(file), false, 'constructing an unused store still writes nothing');
  assert.deepEqual(store.status('42', 'unknown'), { seen: null, revoked: null });
  store.close();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='person_enrollment'").get(),
      'first ordinary device access creates the complete enrollment schema');
    assert.deepEqual(db.prepare('PRAGMA table_info(person_enrollment)').all().map(row => [row.name, row.pk]),
      [['account', 1], ['nonce', 2], ['device', 0], ['expires', 0], ['payload', 0], ['used', 0], ['wrapped', 0]]);
    assert.equal(db.prepare('SELECT count(*) AS count FROM person_enrollment').get().count, 0,
      'schema creation neither fabricates an enrollment nor releases a wrap');
  } finally { db.close(); }
});
