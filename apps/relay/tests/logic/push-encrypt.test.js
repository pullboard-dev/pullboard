/** Web Push payload encryption (RFC 8291, aes128gcm) round-trips with node:crypto and refuses a changed byte [C7]. */
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';
import { createECDH } from 'node:crypto';
import { hkdfSync } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { encryptPush } from '../../src/logic/push/encrypt.js';

/** A subscriber as a browser holds it: a P-256 key pair and a 16-byte auth secret. */
function subscriber() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }, auth };
}

/** Decrypt a body the way the subscriber's browser does, from its own private key; throws when authentication fails. */
function decryptPush(body, { ecdh, auth }) {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const senderPublic = body.subarray(21, 21 + idLength);
  const record = body.subarray(21 + idLength);
  const shared = ecdh.computeSecret(senderPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), senderPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, auth, keyInfo, 32));
  const key = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([decipher.update(record.subarray(0, record.length - 16)), decipher.final()]);
  assert.equal(plain[plain.length - 1], 2, 'the record ends with the last-record delimiter');
  return plain.subarray(0, plain.length - 1);
}

test('clause 1: an encrypted payload decrypts back to the payload with the subscriber\'s private key [C7]', () => {
  const sub = subscriber();
  const payload = JSON.stringify({ kind: 'wake', blob: 'sealed' });
  const body = encryptPush(payload, sub.keys);
  assert.equal(body.readUInt32BE(16), 4096, 'the record size field is set');
  assert.equal(body[20], 65, 'the key id is the 65-byte sender public key');
  assert.equal(decryptPush(body, sub).toString('utf8'), payload);
  assert.notEqual(encryptPush(payload, sub.keys).toString('hex'), body.toString('hex'), 'each encryption uses a fresh salt and sender key');
});

test('clause 1: a fixed salt and sender key give the same bytes, and an empty and a maximal payload round-trip [C7]', () => {
  const sub = subscriber();
  const senderKey = createECDH('prime256v1');
  senderKey.generateKeys();
  const salt = randomBytes(16);
  assert.deepEqual(encryptPush('x', sub.keys, { salt, senderKey }), encryptPush('x', sub.keys, { salt, senderKey }));
  assert.equal(decryptPush(encryptPush('', sub.keys), sub).length, 0);
  const big = randomBytes(3979);
  assert.deepEqual(decryptPush(encryptPush(big, sub.keys), sub), big);
  assert.throws(() => encryptPush(randomBytes(3980), sub.keys), RangeError);
});

test('clause 1: a changed byte anywhere in the record fails to decrypt, and another subscriber cannot read it [C7]', () => {
  const sub = subscriber();
  const body = encryptPush('sealed text', sub.keys);
  const header = 21 + body[20];
  for (const at of [0, header, header + 3, body.length - 1]) {
    const changed = Buffer.from(body);
    changed[at] ^= 1;
    assert.throws(() => decryptPush(changed, sub), `byte ${at} changed`);
  }
  assert.throws(() => decryptPush(body, subscriber()));
});

test('clause 1: a malformed subscription key or auth secret is refused before encrypting [C7]', () => {
  const sub = subscriber();
  assert.throws(() => encryptPush('x', { ...sub.keys, auth: randomBytes(15).toString('base64url') }), TypeError);
  assert.throws(() => encryptPush('x', { ...sub.keys, p256dh: randomBytes(65).toString('base64url') }), TypeError);
  assert.throws(() => encryptPush('x', {}), TypeError);
});
