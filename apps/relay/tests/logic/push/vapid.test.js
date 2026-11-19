/** vapidAuth signs its token through the keys signing adapter [C7,#1428]. @pullboard-test-input source-cell apps/relay */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { verify } from 'node:crypto';
import { test } from 'node:test';
import { vapidAuth } from '../../../src/logic/push/vapid.js';
import { loadSigningAdapter } from '../../../../../packages/keys/index.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');

test('relay.logic-push-vapid.signing-adapter-token-verifies: clause 1: the token is signed through the keys signing adapter and its signature verifies with node:crypto against the VAPID public key [C7,#1428]', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const token = vapidAuth('https://push.example.net/send/abc', 'mailto:ops@example.com', pem, NOW);
  const [head, body, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  assert.equal(verify('sha256', Buffer.from(`${head}.${body}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
});

test('relay.logic-push-vapid.signing-adapter-fake-injected: clause 2: with createFakeSigningAdapter injected, vapidAuth returns the fake signature as the token tail [C7,#1428]', async () => {
  const { createFakeSigningAdapter } = await loadSigningAdapter();
  const fake = createFakeSigningAdapter();
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const token = vapidAuth('https://push.example.net/send/abc', 'mailto:ops@example.com', privateKey, NOW, fake);
  const [head, body, signature] = token.split('.');
  assert.equal(signature, fake.signWith({ algorithm: 'ES256', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }, `${head}.${body}`));
  assert.equal(Buffer.from(signature, 'base64url').toString(), `fake-ES256|${head}.${body}`);
});
