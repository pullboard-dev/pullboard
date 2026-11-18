/** A VAPID token is signed with ES256 and verifies against its public key [C7]. @pullboard-test-input source-cell apps/relay */
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { verify } from 'node:crypto';
import { test } from 'node:test';
import { vapidAuth } from '../../src/logic/push/vapid.js';

const NOW = Date.parse('2026-11-16T12:00:00Z');

/** Split a token into its decoded header and claims and its raw signature. */
function open(token) {
  const [head, body, signature] = token.split('.');
  return { signed: `${head}.${body}`, header: JSON.parse(Buffer.from(head, 'base64url')), claims: JSON.parse(Buffer.from(body, 'base64url')), signature: Buffer.from(signature, 'base64url') };
}

test('relay.logic-push-vapid.the-token-verifies-as-es256-against: clause 1: the token verifies as ES256 against the public key and not against another key [C7]', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey;
  const { signed, header, signature } = open(vapidAuth('https://push.example.net/send/abc', 'mailto:ops@example.com', privateKey, NOW));
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' });
  assert.equal(signature.length, 64, 'ES256 signatures are the raw 64-byte r||s form');
  assert.equal(verify('sha256', Buffer.from(signed), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature), true);
  assert.equal(verify('sha256', Buffer.from(signed), { key: other, dsaEncoding: 'ieee-p1363' }, signature), false);
});

test('relay.logic-push-vapid.the-claims-carry-the-endpoint-origin: clause 1: the claims carry the endpoint origin as audience, the subject, and an expiry inside 12 hours [C7]', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const { claims } = open(vapidAuth('https://push.example.net:8443/send/abc?x=1', 'mailto:ops@example.com', pem, NOW));
  assert.equal(claims.aud, 'https://push.example.net:8443');
  assert.equal(claims.sub, 'mailto:ops@example.com');
  assert.ok(claims.exp > NOW / 1000 && claims.exp - NOW / 1000 <= 12 * 3600, 'expires in the future and within 12 hours');
});
