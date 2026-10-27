/** Real auth, SQLite and loopback HTTP [H5,H15,H17]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createAuthHandler } from '../relay/auth-http.js';
import { createDeviceHandler } from '../relay/device-http.js';
import { createDeviceStore } from '../relay/device-store.js';
import { createGitHubClient } from '../relay/github.js';
import {
  ACCESS_WINDOW_MS,
  createRelayAuth,
} from '../relay/auth.js';
import { createRelayHandler } from '../relay/service.js';
import { Refused } from '../src/refused.js';
import { ENGINE_VERSION } from '../src/machine.js';
import {
  authenticateDeviceEnrollment,
  createDeviceKeys,
  signDeviceEnrollment,
  unwrapDeviceBoardKey,
  wrapDeviceBoardKey,
} from '../src/relay-device-keys.js';
import { githubFixture } from './relay-fixture.js';
import { excludedInventoryId } from '../relay/excluded-store.js';
import {
  seal,
  unseal,
} from '../src/seal.js';

test('excluded inventories keep names sealed, isolate accounts and refuse revoked devices [H5,H15,H17]', async t => {
  const box = await relayDeviceFixture(t);
  const owner = await browserSession(box);
  const phone = await createDeviceKeys();
  const registered = await deviceRequest(box, '/api/v1/devices/' + phone.deviceId, {
    method: 'POST', cookie: owner, origin: box.origin, body: {},
  });
  assert.equal(registered.response.status, 200);
  const machine = 'machine-excluded-fixture';
  const label = 'Fixture computer';
  const id = excludedInventoryId(machine, '7');
  const key = new Uint8Array(randomBytes(32));
  const plain = new TextEncoder().encode(JSON.stringify({ account: '7', machine, label, names: ['fixture/private-excluded'] }));
  const sealed = Buffer.from(await seal(key, plain, { boardId: id, kind: 'snapshot', sequence: 0 })).toString('base64url');
  const envelope = await wrapDeviceBoardKey(key, phone.publicKey, { board: id, device: phone.deviceId, engine: ENGINE_VERSION });
  const body = { machine, label, count: 1, engine: ENGINE_VERSION, sealed,
    wraps: [{ device: phone.deviceId, wrapped: Buffer.from(JSON.stringify(envelope)).toString('base64url') }] };
  const path = '/api/v1/devices/exclusions';
  const denied = await deviceRequest(box, path);
  assert.equal(denied.document.error?.code, 'AUTH_REQUIRED');
  const foreignOrigin = await deviceRequest(box, path, { method: 'POST', cookie: owner, origin: 'https://foreign.invalid', body });
  assert.equal(foreignOrigin.document.error?.code, 'BAD_ORIGIN');
  assert.deepEqual((await deviceRequest(box, path, { cookie: owner })).document.exclusions, []);
  const extra = await deviceRequest(box, path, { method: 'POST', cookie: owner, origin: box.origin, body: { ...body, names: ['forbidden'] } });
  assert.equal(extra.document.error?.code, 'EXCLUDED_INVENTORY', 'plaintext name fields are refused');
  assert.equal((await deviceRequest(box, path, { method: 'POST', cookie: owner, origin: box.origin, body })).response.status, 200);
  const board = 'b'.repeat(32);
  assert.equal((await deviceRequest(box, '/auth/boards/link', { method: 'POST', cookie: owner,
    origin: box.origin, body: { board, repository: 'fixture/repository' } })).response.status, 200);
  const issued = await deviceRequest(box, '/auth/machines', { method: 'POST', cookie: owner,
    origin: box.origin, body: { board, machine } });
  assert.equal(issued.response.status, 201);
  const token = issued.document.token;
  assert.equal((await deviceRequest(box, path, { method: 'POST', token, engine: ENGINE_VERSION, body })).response.status, 200,
    'the enrolled machine can publish immediately without a retained person session');
  assert.equal((await deviceRequest(box, path, { token, engine: ENGINE_VERSION })).document.error?.code, 'HUMAN_REQUIRED',
    'a machine credential cannot read the account inventory');
  assert.equal((await deviceRequest(box, path, { method: 'POST', token, engine: ENGINE_VERSION,
    body: { ...body, machine: 'another-machine' } })).document.error?.code, 'EXCLUDED_INVENTORY',
    'a machine credential cannot replace another machine’s list');
  box.restart();
  const metadata = await deviceRequest(box, path, { cookie: owner });
  assert.deepEqual(metadata.document.exclusions, [{ machine, label, count: 1 }], 'durable public metadata has no name, key or wrap');
  box.state.accountID = 8;
  const other = await browserSession(box);
  assert.deepEqual((await deviceRequest(box, path, { cookie: other })).document.exclusions, []);
  const devicePath = '/api/v1/devices/' + phone.deviceId + '/exclusions';
  assert.equal((await deviceRequest(box, devicePath, { cookie: other })).document.error?.code, 'DEVICE_NOT_ENROLLED');
  box.state.accountID = 7;
  const delivered = await deviceRequest(box, devicePath, { cookie: owner });
  assert.equal(delivered.response.status, 200);
  const row = delivered.document.exclusions[0];
  const openedKey = await unwrapDeviceBoardKey(phone.privateKey,
    JSON.parse(Buffer.from(row.wrapped, 'base64url').toString('utf8')), { board: row.id, device: phone.deviceId, engine: row.engine });
  assert.deepEqual(await unseal(openedKey, new Uint8Array(Buffer.from(row.sealed, 'base64url')),
    { boardId: row.id, kind: 'snapshot', sequence: 0 }), plain);
  const stored = readFileSync(join(box.relayDirectory, 'devices.sqlite'));
  assert.equal(stored.includes('fixture/private-excluded'), false, 'the relay database has no repository plaintext');
  assert.equal(stored.includes(Buffer.from(key)), false, 'the relay database has no raw list key');
  assert.equal(stored.includes(Buffer.from(key).toString('base64url')), false, 'the relay database has no transport key');
  const freshOwner = await browserSession(box);
  assert.equal((await deviceRequest(box, '/api/v1/devices/' + phone.deviceId, {
    method: 'DELETE', cookie: freshOwner, origin: box.origin,
  })).response.status, 200);
  assert.equal((await deviceRequest(box, devicePath, { cookie: freshOwner })).document.error?.code, 'DEVICE_REVOKED',
    'a fresh sign-in cannot use the removed device’s old private key to fetch a new wrap');
  const cleared = await deviceRequest(box, path, { method: 'POST', cookie: freshOwner, origin: box.origin,
    body: { ...body, count: 0, sealed: '', wraps: [] } });
  assert.equal(cleared.response.status, 200);
  assert.deepEqual((await deviceRequest(box, path, { cookie: freshOwner })).document.exclusions, [], 'including the last board removes the publication');
});

/** Start actual relay/auth HTTP handlers with private SQLite and a real GitHub protocol fixture. */
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

/** Create the exact public enrollment body that the paired phone signs with its one-use secret. */
async function signedDevice(box, account, locator) {
  const keys = await createDeviceKeys();
  const secret = randomBytes(32);
  const input = { v: 1, account, locator, deviceId: keys.deviceId, publicKey: keys.publicKey,
    label: 'Fixture phone', createdAt: new Date().toISOString() };
  return { keys, secret, input, signed: await signDeviceEnrollment(secret, input) };
}

test('relay devices isolate accounts, persist opaque wraps, expire enrollments and tombstone revocation [H5,H15,H17]', async (t) => {
  const box = await relayDeviceFixture(t);
  const cookieA = await browserSession(box);
  const identityA = await deviceRequest(box, '/auth/session', { cookie: cookieA });
  assert.equal(identityA.document.session.user.id, '7');
  const boardA = 'a'.repeat(32);
  const linkA = await deviceRequest(box, '/auth/boards/link', { method: 'POST', cookie: cookieA, origin: box.origin,
    body: { board: boardA, repository: 'fixture/repository' } });
  assert.equal(linkA.response.status, 200);

  // A cookie write from another origin is refused before it creates the pending enrollment.
  const rejectedCookieWrite = await deviceRequest(box, '/api/v1/devices/enrollments/AAAAAAAAAAAAAAAAAAAAAA', {
    method: 'POST', cookie: cookieA, origin: 'https://foreign.invalid', body: {},
  });
  assert.equal(rejectedCookieWrite.document.error?.code, 'BAD_ORIGIN');

  const locator = Buffer.from(randomBytes(16)).toString('base64url');
  const pair = await signedDevice(box, identityA.document.session.user.id, locator);
  const begin = await deviceRequest(box, `/api/v1/devices/enrollments/${locator}`, {
    method: 'POST', cookie: cookieA, origin: box.origin, body: {},
  });
  assert.equal(begin.response.status, 200);
  const upload = await deviceRequest(box, `/api/v1/devices/enrollments/${locator}`, {
    method: 'PUT', cookie: cookieA, origin: box.origin, body: pair.signed,
  });
  assert.equal(upload.response.status, 200);

  // A second real GitHub account cannot read this account's enrollment or use its device id.
  box.state.accountID = 8;
  const cookieB = await browserSession(box);
  const identityB = await deviceRequest(box, '/auth/session', { cookie: cookieB });
  assert.equal(identityB.document.session.user.id, '8');
  const hiddenEnrollment = await deviceRequest(box, `/api/v1/devices/enrollments/${locator}`, { cookie: cookieB });
  assert.equal(hiddenEnrollment.document.error?.code, 'DEVICE_PAIR_EXPIRED');

  // Restore provider identity for the existing A session; the enrollment arrives unchanged for local MAC validation.
  box.state.accountID = 7;
  const delivered = await deviceRequest(box, `/api/v1/devices/enrollments/${locator}`, { cookie: cookieA, origin: box.origin });
  assert.deepEqual(delivered.document.enrollment, pair.signed);
  const accepted = await authenticateDeviceEnrollment(pair.secret, delivered.document.enrollment, {
    account: identityA.document.session.user.id, locator,
  });
  assert.deepEqual(accepted.publicKey, pair.keys.publicKey);
  const registered = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}`, {
    method: 'POST', cookie: cookieA, origin: box.origin, body: {},
  });
  assert.equal(registered.response.status, 200);
  const consumed = await deviceRequest(box, `/api/v1/devices/enrollments/${locator}`, {
    method: 'DELETE', cookie: cookieA, origin: box.origin,
  });
  assert.equal(consumed.response.status, 200);

  const boardKey = new Uint8Array(randomBytes(32));
  const wrap = await wrapDeviceBoardKey(boardKey, accepted.publicKey, {
    board: boardA, device: pair.keys.deviceId, engine: ENGINE_VERSION,
  });
  const wrapped = Buffer.from(JSON.stringify(wrap)).toString('base64url');
  const putWrap = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}/boards/${boardA}`, {
    method: 'PUT', cookie: cookieA, origin: box.origin, engine: ENGINE_VERSION,
    body: { engine: ENGINE_VERSION, wrapped },
  });
  assert.equal(putWrap.response.status, 200);
  const wraps = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}/boards`, {
    cookie: cookieA, origin: box.origin,
  });
  const deliveredWrap = JSON.parse(Buffer.from(wraps.document.wraps[0].wrapped, 'base64url').toString('utf8'));
  assert.deepEqual(await unwrapDeviceBoardKey(pair.keys.privateKey, deliveredWrap, {
    board: boardA, device: pair.keys.deviceId, engine: ENGINE_VERSION,
  }), boardKey);

  // Neither the raw key nor its transport string appears in the durable relay device database.
  const deviceDb = readFileSync(join(box.relayDirectory, 'devices.sqlite'));
  assert.equal(deviceDb.includes(boardKey), false);
  assert.equal(deviceDb.includes(Buffer.from(boardKey).toString('base64url')), false);

  // The independent account and an agent credential cannot retrieve the owner's wraps.
  const crossAccount = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}/boards`, {
    cookie: cookieB,
  });
  assert.equal(crossAccount.document.error?.code, 'DEVICE_NOT_ENROLLED');
  // Even if the other account can write this repository, it cannot add data to A's device id.
  box.state.permissionAccountID = 8;
  const cachedForeignPut = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}/boards/${boardA}`, {
    method: 'PUT', cookie: cookieB, origin: box.origin, engine: ENGINE_VERSION,
    body: { engine: ENGINE_VERSION, wrapped },
  });
  assert.equal(cachedForeignPut.document.error?.code, 'NO_REPO_ACCESS',
    'restored repository permission does not bypass the cached denial inside its window');
  box.advance(ACCESS_WINDOW_MS);
  const foreignPut = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}/boards/${boardA}`, {
    method: 'PUT', cookie: cookieB, origin: box.origin, engine: ENGINE_VERSION,
    body: { engine: ENGINE_VERSION, wrapped },
  });
  assert.equal(foreignPut.document.error?.code, 'DEVICE_NOT_ENROLLED');
  box.state.permissionAccountID = 7;
  const issued = await deviceRequest(box, '/auth/tokens', { method: 'POST', cookie: cookieA, origin: box.origin,
    body: { board: boardA, agent: 'fixture-agent' } });
  assert.equal(issued.response.status, 201);
  const agentRead = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}/boards`, { token: issued.document.token });
  assert.equal(agentRead.document.error?.code, 'TOKEN_BOARD');

  // A new service/auth process sees the same persisted device and ciphertext without the key in its DB.
  box.restart();
  const afterRestart = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}/boards`, {
    cookie: cookieA, origin: box.origin,
  });
  assert.equal(afterRestart.response.status, 200);
  const persistedWrap = JSON.parse(Buffer.from(afterRestart.document.wraps[0].wrapped, 'base64url').toString('utf8'));
  assert.deepEqual(await unwrapDeviceBoardKey(pair.keys.privateKey, persistedWrap, {
    board: boardA, device: pair.keys.deviceId, engine: ENGINE_VERSION,
  }), boardKey);

  // Expiration is bounded and does not refresh on read; revocation tombstones the id and deletes wraps.
  const expiringLocator = Buffer.from(randomBytes(16)).toString('base64url');
  await deviceRequest(box, `/api/v1/devices/enrollments/${expiringLocator}`, {
    method: 'POST', cookie: cookieA, origin: box.origin, body: {},
  });
  box.advance(600_001);
  const expired = await deviceRequest(box, `/api/v1/devices/enrollments/${expiringLocator}`, {
    cookie: cookieA, origin: box.origin,
  });
  assert.equal(expired.document.error?.code, 'DEVICE_PAIR_EXPIRED');

  const revoked = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}`, {
    method: 'DELETE', cookie: cookieA, origin: box.origin,
  });
  assert.equal(revoked.response.status, 200);
  const staleUpload = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}/boards/${boardA}`, {
    method: 'PUT', cookie: cookieA, origin: box.origin, engine: ENGINE_VERSION,
    body: { engine: ENGINE_VERSION, wrapped },
  });
  assert.equal(staleUpload.document.error?.code, 'DEVICE_REVOKED');
  const staleRegistration = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}`, {
    method: 'POST', cookie: cookieA, origin: box.origin, body: {},
  });
  assert.equal(staleRegistration.document.error?.code, 'DEVICE_REVOKED');
  const noWrapsAfterRevoke = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}/boards`, {
    cookie: cookieA, origin: box.origin,
  });
  assert.equal(noWrapsAfterRevoke.document.error?.code, 'DEVICE_REVOKED');

  box.restart();
  const persistedRefusal = await deviceRequest(box, '/api/v1/boards', { cookie: cookieA });
  assert.equal(persistedRefusal.document.error?.code, 'DEVICE_REVOKED', 'closing and reopening the actual auth and device databases retains the browser session revocation');
  assert.equal(persistedRefusal.response.status, 403);
  const freshCookie = await browserSession(box);
  const recovery = await deviceRequest(box, '/api/v1/devices/session', { cookie: freshCookie });
  assert.equal(recovery.response.status, 200, 'a fresh independently provider-authenticated session remains available for lost-phone recovery');
  const visible = await deviceRequest(box, '/api/v1/boards', { cookie: freshCookie });
  assert.equal(visible.response.status, 200);
  assert.equal(visible.document.boards.some(board => board.id === boardA), true);
  const oldId = await deviceRequest(box, `/api/v1/devices/${pair.keys.deviceId}`, {
    method: 'POST', cookie: freshCookie, origin: box.origin, body: {},
  });
  assert.equal(oldId.document.error?.code, 'DEVICE_REVOKED', 'a fresh sign-in does not resurrect the tombstoned device id');
});

test('pending phone link names are session-scoped and exclude used or expired approvals [H5,H15,H17]', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-device-approvals-'));
  let now = 1_800_000_000_000;
  const devices = createDeviceStore({ directory: root, now: () => now });
  const account = '7';
  const other = '8';
  const device = 'device-' + 'a'.repeat(32);
  const publisher = 'b'.repeat(32);
  devices.register(account, device);
  devices.register(other, device);
  /** Make one valid pending phone action with an independently selected account and board. */
  const context = (id, owner, board, action, target, expires) => ({ id, account: owner, publisher, board, device, action, target,
    machine: 'machine-one', command: 'pullboard relay on --all', expires });
  /** Store an encrypted request through the same approval validation used by the relay endpoint. */
  const add = (value) => devices.requestApproval(value.account, value, 'sealed-intent');
  add(context('live-link', account, 'c'.repeat(32), 'link', 'fixture/live', now + 60_000));
  add(context('other-link', other, 'd'.repeat(32), 'link', 'fixture/private', now + 60_000));
  add(context('used-link', account, 'e'.repeat(32), 'link', 'fixture/used', now + 30_000));
  devices.completeApproval(account, 'used-link', 'phone-response');
  add(context('expired-link', account, 'f'.repeat(32), 'link', 'fixture/expired', now + 1));
  add(context('live-revoke', account, publisher, 'revoke-device', device, now + 60_000));
  now += 2;

  const server = createServer(createDeviceHandler({
    authenticate: async (req) => {
      const cookie = req.headers.cookie;
      if (cookie === 'revoked=1') throw new Refused('DEVICE_REVOKED', 'revoked');
      return { kind: cookie === 'machine=1' ? 'machine' : 'session', user: { id: cookie === 'other=1' ? other : account } };
    },
    authorizeBoard: async () => {}, boardsFor: async () => [], devices,
    linkBoard: async () => {}, issueMachine: async () => {}, issueActionGrant: async () => {},
    consumeActionGrant: async () => {}, revokeToken: async () => {}, deleteBoard: async () => {},
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); devices.close?.(); rmSync(root, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  /** Read the public pending-link endpoint as a chosen authenticated principal. */
  const get = async (cookie) => {
    const response = await fetch(origin + '/api/v1/devices/approvals', { headers: { cookie } });
    return { response, document: await response.json() };
  };

  const own = await get('owner=1');
  assert.deepEqual(own.document.links, [{ name: 'fixture/live' }], 'only live link-request names leave the account boundary');
  assert.equal(own.document.links[0].sealed, undefined, 'the browser never receives the sealed intent');
  assert.deepEqual((await get('other=1')).document.links, [{ name: 'fixture/private' }], 'another signed-in account sees only its own request');
  const machine = await get('machine=1');
  assert.equal(machine.response.status, 403);
  assert.equal(machine.document.error?.code, 'HUMAN_REQUIRED');
  const revoked = await get('revoked=1');
  assert.equal(revoked.response.status, 403);
  assert.equal(revoked.document.error?.code, 'DEVICE_REVOKED');
});
