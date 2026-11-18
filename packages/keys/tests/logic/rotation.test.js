/** Board key rotation on member removal through the keys front door; actual WebCrypto only [E16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceKeys } from '../../index.js';
import { rotateBoardKeyForRoster } from '../../index.js';
import { unwrapDeviceBoardKey } from '../../index.js';

const BOARD = '0123456789abcdef0123456789abcdef';
const ENGINE = 7;

/** Three paired devices, the roster rows for them, and a rotation that removes the middle one. */
async function rotated() {
  const devices = [await createDeviceKeys(), await createDeviceKeys(), await createDeviceKeys()];
  const roster = devices.map(({ deviceId, publicKey }) => ({ deviceId, publicKey }));
  const old = crypto.getRandomValues(new Uint8Array(32));
  const removed = devices[1];
  const result = await rotateBoardKeyForRoster(old, roster, removed.deviceId, { board: BOARD, engine: ENGINE });
  return { devices, roster, old, removed, ...result };
}

test('keys.rotation.rotateboardkeyforroster-returns-a-new-32-byte: clause 1: rotateBoardKeyForRoster returns a new 32-byte key with one envelope per remaining device and none for the removed one [E16]', async () => {
  const { devices, old, removed, key, envelopes } = await rotated();
  assert.equal(key.length, 32);
  assert.notDeepEqual(key, old);
  assert.deepEqual(Object.keys(envelopes).sort(), devices.filter(d => d !== removed).map(d => d.deviceId).sort());
  assert.equal(envelopes[removed.deviceId], undefined);
});

test('keys.rotation.every-remaining-envelope-unwraps-to-the: clause 2: every remaining envelope unwraps to the new key with its own private key and the removed device key unwraps none [E16]', async () => {
  const { devices, removed, key, envelopes } = await rotated();
  for (const device of devices.filter(d => d !== removed)) {
    const expected = { board: BOARD, device: device.deviceId, engine: ENGINE };
    assert.deepEqual(await unwrapDeviceBoardKey(device.privateKey, envelopes[device.deviceId], expected), key);
    await assert.rejects(unwrapDeviceBoardKey(removed.privateKey, envelopes[device.deviceId], expected), { code: 'DEVICE_WRAP_AUTH' });
  }
  await assert.rejects(rotateBoardKeyForRoster(key, devices.map(d => ({ deviceId: d.deviceId, publicKey: d.publicKey })), 'ffffffffffffffffffffffffffffffff', { board: BOARD, engine: ENGINE }), { code: 'DEVICE_WRAP_BINDING' });
});
