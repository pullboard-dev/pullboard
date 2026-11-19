/** @pullboard-test-input source-cell apps/relay */
/** The relay stores one push subscription per paired device, wakes it, and ends it on revoke [C7]. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createECDH } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { createRelayHandler } from '../../src/io/service.js';
import { createPushSubscriptions } from '../../src/io/push/subscriptions.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

/** A browser subscription with real P-256 keys, as the push service would hand out. */
function subscription(endpoint = 'https://push.example/abc') {
  const phone = createECDH('prime256v1');
  phone.generateKeys();
  return { endpoint, keys: { p256dh: phone.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

/** A store on a temp folder with a recording fetch. */
function setup(on) {
  const directory = privateFixtureFiles('pullboard-push-').root;
  const calls = [];
  const store = createPushSubscriptions({
    directory,
    enabled: () => on,
    fetch: async (url, init) => { calls.push({ url, init }); return { ok: true }; },
    vapidKey: pem,
    vapidPublic: 'public-key',
    subject: 'mailto:ops@example.com',
  });
  return { store, calls, done: () => rmSync(directory, { recursive: true, force: true }) };
}

test('relay.io-push-subscriptions.with-relay-push-on-a-paired: clause 1: with relay.push on, a paired device is woken for an alert and, once revoked, is not [C7]', async () => {
  const { store, calls, done } = setup(true);
  try {
    assert.equal(store.subscribe('acct', 'phone', subscription()), true);
    assert.equal(await store.wake('acct', 'alerts', Uint8Array.from([1, 2, 3])), 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://push.example/abc');
    assert.equal(calls[0].init.headers['content-encoding'], 'aes128gcm');
    assert.match(calls[0].init.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=public-key$/u);
    store.revoke('acct', 'phone');
    assert.equal(await store.wake('acct', 'alerts', Uint8Array.from([1, 2, 3])), 0);
    assert.equal(calls.length, 1);
  } finally { done(); }
});

test('relay.io-push-subscriptions.a-second-subscription-from-the-same: clause 1: a second subscription from the same device replaces the first [C7]', async () => {
  const { store, calls, done } = setup(true);
  try {
    store.subscribe('acct', 'phone', subscription('https://push.example/old'));
    store.subscribe('acct', 'phone', subscription('https://push.example/new'));
    assert.equal(await store.wake('acct', 'landings', Uint8Array.from([9])), 1);
    assert.equal(calls[0].url, 'https://push.example/new');
  } finally { done(); }
});

test('relay.io-push-subscriptions.with-relay-push-off-nothing-is: clause 2: with relay.push off nothing is stored or sent [C7]', async () => {
  const { store, calls, done } = setup(false);
  try {
    assert.equal(store.subscribe('acct', 'phone', subscription()), false);
    assert.equal(await store.wake('acct', 'alerts', Uint8Array.from([1])), 0);
    store.revoke('acct', 'phone');
    assert.equal(calls.length, 0);
  } finally { done(); }
});

const TOKEN = `ps_${'A'.repeat(43)}`;
const DEVICE = `device-${'a'.repeat(32)}`;

/** A relay handler on a loopback port whose one signed-in person is account "acct", with push on or off. */
async function relay(t, on) {
  const directory = privateFixtureFiles('pullboard-push-route-').root;
  const calls = [];
  const auth = {
    async authenticate(token) {
      if (token !== TOKEN) throw new Refused('AUTH_REQUIRED', 'sign in');
      return { id: token, kind: 'session', user: { id: 'acct', login: 'fixture' } };
    },
    linkedBoards() { return []; },
    forgetBoard() {},
    minimumEngineVersion() { return 1; },
    withBoard(_board, work) { return work({}); },
    pendingCleanup() { return []; },
    finishCleanup() {},
    withCleanup(_board, work) { return work(); },
  };
  const push = on ? { enabled: () => true, fetch: async (url, init) => { calls.push({ url, init }); return { ok: true }; }, vapidKey: pem, vapidPublic: 'public-key', subject: 'mailto:ops@example.com' } : undefined;
  const service = createRelayHandler({ directory, auth, maintenanceMs: 0, push });
  const server = createServer((req, res) => { void service(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    service.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  /** Call the relay as the signed-in person and return its status and JSON body. */
  async function call(method, path, body) {
    const response = await fetch(base + path, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { call, calls, directory };
}

test('relay.io-push-subscriptions.subscribe-route-stores-device: clause 1: with relay.push on, a paired device posts push/subscribe through handle() and the relay stores one subscription with its kinds and publishes the VAPID public key; with relay.push off nothing is stored [C7]', async t => {
  const on = await relay(t, true);
  assert.equal((await on.call('POST', `/api/v1/devices/${DEVICE}`, {})).status, 200);
  const config = (await on.call('GET', '/api/v1/push/config')).body;
  assert.deepEqual([config.enabled, config.vapidPublicKey], [true, 'public-key']);
  const unpaired = await on.call('POST', '/api/v1/push/subscribe', { device: `device-${'b'.repeat(32)}`, subscription: subscription(), kinds: ['alerts'] });
  assert.equal(unpaired.body.error.code, 'DEVICE_NOT_ENROLLED');
  const stored = await on.call('POST', '/api/v1/push/subscribe', { device: DEVICE, subscription: subscription('https://push.example/phone'), kinds: ['landings', 'alerts'] });
  assert.equal(stored.status, 200);
  assert.deepEqual([stored.body.subscribed, stored.body.kinds], [true, ['alerts', 'landings']]);
  const db = new DatabaseSync(join(on.directory, 'push.sqlite'));
  try { assert.deepEqual(db.prepare('SELECT account, device, endpoint, kinds FROM push_subscription').all().map(row => ({ ...row })), [{ account: 'acct', device: DEVICE, endpoint: 'https://push.example/phone', kinds: 'alerts,landings' }]); } finally { db.close(); }
  assert.equal((await on.call('POST', '/api/v1/push/subscribe', { device: DEVICE, subscription: subscription(), kinds: ['bogus'] })).body.error.code, 'PUSH_KINDS');

  const off = await relay(t, false);
  assert.equal((await off.call('POST', `/api/v1/devices/${DEVICE}`, {})).status, 200);
  const offConfig = (await off.call('GET', '/api/v1/push/config')).body;
  assert.deepEqual([offConfig.enabled, offConfig.vapidPublicKey], [false, null]);
  const refused = await off.call('POST', '/api/v1/push/subscribe', { device: DEVICE, subscription: subscription(), kinds: ['alerts'] });
  assert.equal(refused.body.error.code, 'PUSH_OFF');
  assert.equal(existsSync(join(off.directory, 'push.sqlite')), false, 'with relay.push off no subscription file is created');
});

test('relay.io-push-subscriptions.revoked-pairing-ends-push: clause 2: revoking the device through the device store ends its push subscription, so a later wake sends it nothing [C7]', async t => {
  const { call, calls, directory } = await relay(t, true);
  await call('POST', `/api/v1/devices/${DEVICE}`, {});
  await call('POST', '/api/v1/push/subscribe', { device: DEVICE, subscription: subscription(), kinds: ['alerts'] });
  const sender = createPushSubscriptions({ directory, enabled: () => true, fetch: async (url, init) => { calls.push({ url, init }); return { ok: true }; }, vapidKey: pem, vapidPublic: 'public-key', subject: 'mailto:ops@example.com' });
  t.after(() => sender.close());
  assert.equal(await sender.wake('acct', 'alerts', Uint8Array.from([1])), 1, 'the subscribed device is woken before it is revoked');
  assert.equal(await sender.wake('acct', 'decisions', Uint8Array.from([1])), 0, 'a kind the device did not choose wakes nothing');
  const sent = calls.length;
  assert.equal((await call('DELETE', `/api/v1/devices/${DEVICE}`)).status, 200);
  assert.equal(sender.kinds('acct', DEVICE), null);
  assert.equal(await sender.wake('acct', 'alerts', Uint8Array.from([1])), 0, 'the revoked device is not woken');
  assert.equal(calls.length, sent);
});
