/** Real device enrollment and key wraps; actual WebCrypto only [H5,H15,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFixtureChild as spawnSync } from './fixture-child.js';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptDeviceEnrollment, beginDeviceEnrollment, readRelayMachine, removeRecordedDevice, wrapForRecordedDevice } from '../src/relay-machine.js';
import {
  authenticateDeviceEnrollment,
  createDeviceKeys,
  signDeviceEnrollment,
  unwrapDeviceBoardKey,
  wrapDeviceBoardKey,
} from '../src/relay-device-keys.js';

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

test('device enrollment keeps its private P-256 key non-extractable and authenticates the exact key [H5,H15,H17]', async () => {
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

test('device wraps encrypt a board key to one device and authenticate board, device and engine [H5,H15,H17]', async () => {
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

/** Exercise the actual owner-only machine file, one-use enrollment and trusted wrapping boundary. */
test('machine device enrollment survives a new process and refuses unrecorded or revoked recipients [H5,H15,H17]', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'pullboard-device-roster-'));
  const priorHome = process.env.PULLBOARD_HOME;
  process.env.PULLBOARD_HOME = home;
  t.after(() => {
    if (priorHome === undefined) delete process.env.PULLBOARD_HOME;
    else process.env.PULLBOARD_HOME = priorHome;
    rmSync(home, { recursive: true, force: true });
  });
  const phone = await createDeviceKeys();
  const other = await createDeviceKeys();
  const owner = { account: 'github-user-42', url: 'http://127.0.0.1:12345' };
  const board = 'c'.repeat(32);
  const key = crypto.getRandomValues(new Uint8Array(32));
  const context = { board, device: phone.deviceId, engine: 5 };
  await assert.rejects(wrapForRecordedDevice(key, context, owner), { code: 'DEVICE_NOT_ENROLLED' });
  const pending = beginDeviceEnrollment(board, owner);
  const signed = await signDeviceEnrollment(pending.secret, await enrollmentFor(phone, {
    account: owner.account, locator: pending.locator,
  }));
  await assert.rejects(acceptDeviceEnrollment({ ...signed, publicKey: other.publicKey }), { code: 'DEVICE_ENROLL_AUTH' });
  assert.equal(readRelayMachine().devices.length, 0, 'a relay substitution cannot enter the trusted roster');
  assert.equal(readRelayMachine().pending.locator, pending.locator, 'an invalid MAC cannot consume the real phone pairing');
  await acceptDeviceEnrollment(signed);
  assert.equal(readRelayMachine().pending, null, 'the authenticated one-use secret is consumed locally');
  await assert.rejects(acceptDeviceEnrollment(signed), error => error.code.startsWith('DEVICE_PAIR_'));
  const wrapped = await wrapForRecordedDevice(key, context, owner);
  assert.deepEqual(await unwrapDeviceBoardKey(phone.privateKey, wrapped, context), key);
  await assert.rejects(wrapForRecordedDevice(key, { ...context, device: other.deviceId }, owner), { code: 'DEVICE_NOT_ENROLLED' });
  await assert.rejects(wrapForRecordedDevice(key, context, { ...owner, account: 'other-account' }), { code: 'DEVICE_NOT_ENROLLED' });
  assert.equal(statSync(join(home, 'relay-machine/state.json')).mode & 0o777, 0o600);
  const module = new URL('../src/relay-machine.js', import.meta.url).href;
  const restarted = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import {readRelayMachine} from ${JSON.stringify(module)}; console.log(JSON.stringify(readRelayMachine().devices.map(device => device.deviceId)));`],
  { env: process.env, encoding: 'utf8' });
  assert.equal(restarted.status, 0, restarted.stderr);
  assert.deepEqual(JSON.parse(restarted.stdout), [phone.deviceId], 'a fresh process sees the same authenticated device');
  removeRecordedDevice(phone.deviceId);
  await assert.rejects(wrapForRecordedDevice(key, context, owner), { code: 'DEVICE_NOT_ENROLLED' });
  assert.equal(readRelayMachine().devices.length, 0);
  assert.equal(readRelayMachine().revocations[0].deviceId, phone.deviceId, 'remote deletion remains queued until acknowledged');
  assert.deepEqual(await unwrapDeviceBoardKey(phone.privateKey, wrapped, context), key, 'revocation does not un-know a delivered key');
});
