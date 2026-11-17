/** Device enrollment authentication and board key wraps through the keys front door; actual WebCrypto only [H5,H15,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authenticateDeviceEnrollment } from '../../index.js';
import { createDeviceKeys } from '../../index.js';
import { signDeviceEnrollment } from '../../index.js';
import { unwrapDeviceBoardKey } from '../../index.js';
import { wrapDeviceBoardKey } from '../../index.js';

/** Encode test bytes using the protocol's canonical unpadded base64url representation. */
function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

/** Make a structurally valid enrollment around a newly generated real P-256 public key. */
async function enrollmentFor(keys, overrides = {}) {
  return {
    v: 1,
    account: 'github-user-42',
    locator: 'AAAAAAAAAAAAAAAAAAAAAA',
    deviceId: keys.deviceId,
    publicKey: keys.publicKey,
    label: 'Phone',
    createdAt: '2026-10-09T12:00:00.000Z',
    ...overrides,
  };
}

/** Exercise the actual owner-only machine file, one-use enrollment and trusted wrapping boundary. */
test('keys.device.device-enrollment-keeps-its-private-p: device enrollment keeps its private P-256 key non-extractable and authenticates the exact key [H5,H15,H17]', async () => {
  const phone = await createDeviceKeys();
  const otherPhone = await createDeviceKeys();
  assert.equal(phone.privateKey.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('jwk', phone.privateKey));
  assert.equal(phone.publicKey.kty, 'EC');
  assert.equal(phone.publicKey.crv, 'P-256');
  assert.equal(phone.publicKey.d, undefined);

  const secret = crypto.getRandomValues(new Uint8Array(32));
  const base = await enrollmentFor(phone);
  const signed = await signDeviceEnrollment(secret, base);
  const expected = { account: base.account, locator: base.locator };
  const accepted = await authenticateDeviceEnrollment(secret, signed, expected);
  assert.equal(accepted.deviceId, phone.deviceId);
  assert.deepEqual(accepted.publicKey, phone.publicKey);
  assert.match(accepted.fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(accepted.label, base.label);
  assert.equal(accepted.createdAt, base.createdAt);

  const substituted = await signDeviceEnrollment(secret, await enrollmentFor(otherPhone));
  await assert.rejects(authenticateDeviceEnrollment(secret, { ...signed, publicKey: substituted.publicKey }, expected),
    { code: 'DEVICE_ENROLL_AUTH' }, 'a relay-substituted but valid public key fails the MAC');
  await assert.rejects(authenticateDeviceEnrollment(secret, signed, { ...expected, account: 'another-account' }),
    { code: 'DEVICE_ENROLL_AUTH' }, 'the expected account is checked locally');
  await assert.rejects(authenticateDeviceEnrollment(secret, signed, { ...expected, locator: 'AAAAAAAAAAAAAAAAAAAAAQ' }),
    { code: 'DEVICE_ENROLL_AUTH' }, 'the expected one-use pairing locator is checked locally');
  const changedMac = Buffer.from(signed.mac, 'base64url');
  changedMac[0] ^= 1;
  await assert.rejects(authenticateDeviceEnrollment(secret, { ...signed, mac: b64url(changedMac) }, expected),
    { code: 'DEVICE_ENROLL_AUTH' }, 'tampered enrollment authentication is refused');
});

test('keys.device.device-wraps-encrypt-a-board-key: device wraps encrypt a board key to one device and authenticate board, device and engine [H5,H15,H17]', async () => {
  const phone = await createDeviceKeys();
  const stranger = await createDeviceKeys();
  const boardKey = crypto.getRandomValues(new Uint8Array(32));
  const context = { board: 'a'.repeat(32), device: phone.deviceId, engine: 5 };
  const first = await wrapDeviceBoardKey(boardKey, phone.publicKey, context);
  const second = await wrapDeviceBoardKey(boardKey, phone.publicKey, context);
  const serialized = JSON.stringify(first);
  assert.equal(first.v, 1);
  assert.equal(first.board, context.board);
  assert.equal(first.device, phone.deviceId);
  assert.equal(first.engine, context.engine);
  assert.notEqual(first.ephemeral.x + first.ephemeral.y, second.ephemeral.x + second.ephemeral.y,
    'each wrap uses a fresh ephemeral ECDH key');
  assert.equal(serialized.includes(Buffer.from(boardKey).toString('base64url')), false,
    'the serialized relay envelope never contains the raw board key');
  assert.deepEqual(await unwrapDeviceBoardKey(phone.privateKey, first, context), boardKey);

  await assert.rejects(unwrapDeviceBoardKey(stranger.privateKey, first, context), { code: 'DEVICE_WRAP_AUTH' },
    'a non-recipient device cannot open this key');
  for (const expected of [
    { ...context, board: 'b'.repeat(32) },
    { ...context, device: stranger.deviceId },
    { ...context, engine: context.engine + 1 },
  ]) {
    await assert.rejects(unwrapDeviceBoardKey(phone.privateKey, first, expected), { code: 'DEVICE_WRAP_AUTH' });
  }
  await assert.rejects(unwrapDeviceBoardKey(phone.privateKey, { ...first, engine: context.engine + 1 },
    { ...context, engine: context.engine + 1 }), { code: 'DEVICE_WRAP_AUTH' },
  'changing both the relay envelope and expected engine still fails GCM authentication');
  const changed = { ...first, ciphertext: b64url(Buffer.from(first.ciphertext, 'base64url').map((byte, index) => index === 0 ? byte ^ 1 : byte)) };
  await assert.rejects(unwrapDeviceBoardKey(phone.privateKey, changed, context), { code: 'DEVICE_WRAP_AUTH' },
    'ciphertext tampering is rejected by AES-GCM');
});
