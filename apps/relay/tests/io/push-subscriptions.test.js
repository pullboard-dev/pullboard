/** @pullboard-test-input source-cell apps/relay */
/** The relay stores one push subscription per paired device, wakes it, and ends it on revoke [C7]. */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createECDH } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
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

test('clause 1: with relay.push on, a paired device is woken for an alert and, once revoked, is not [C7]', async () => {
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

test('clause 1: a second subscription from the same device replaces the first [C7]', async () => {
  const { store, calls, done } = setup(true);
  try {
    store.subscribe('acct', 'phone', subscription('https://push.example/old'));
    store.subscribe('acct', 'phone', subscription('https://push.example/new'));
    assert.equal(await store.wake('acct', 'landings', Uint8Array.from([9])), 1);
    assert.equal(calls[0].url, 'https://push.example/new');
  } finally { done(); }
});

test('clause 2: with relay.push off nothing is stored or sent [C7]', async () => {
  const { store, calls, done } = setup(false);
  try {
    assert.equal(store.subscribe('acct', 'phone', subscription()), false);
    assert.equal(await store.wake('acct', 'alerts', Uint8Array.from([1])), 0);
    store.revoke('acct', 'phone');
    assert.equal(calls.length, 0);
  } finally { done(); }
});
