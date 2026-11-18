/** One board key wrapped to every device in a roster through the keys front door; actual WebCrypto only [E16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDeviceKeys } from '../../index.js';
import { unwrapDeviceBoardKey } from '../../index.js';
import { wrapBoardKeyToRoster } from '../../index.js';

const BOARD = '0123456789abcdef0123456789abcdef';
const ENGINE = 7;

/** Three real paired devices and the roster rows the relay machine keeps for them. */
async function threeDevices() {
  const devices = [await createDeviceKeys(), await createDeviceKeys(), await createDeviceKeys()];
  return { devices, roster: devices.map(({ deviceId, publicKey }) => ({ deviceId, publicKey })) };
}

test('keys.roster.wrapboardkeytoroster-given-a-board-key-and: clause 1: wrapBoardKeyToRoster given a board key and a roster of three devices returns one envelope per device, keyed by deviceId [E16]', async () => {
  const { roster } = await threeDevices();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const envelopes = await wrapBoardKeyToRoster(key, roster, { board: BOARD, engine: ENGINE });
  assert.deepEqual(Object.keys(envelopes).sort(), roster.map(row => row.deviceId).sort());
  for (const row of roster) {
    assert.equal(envelopes[row.deviceId].device, row.deviceId, 'each envelope is bound to its own device');
    assert.equal(envelopes[row.deviceId].board, BOARD);
    assert.equal(envelopes[row.deviceId].engine, ENGINE);
  }
  await assert.rejects(wrapBoardKeyToRoster(key, [roster[0], roster[0]], { board: BOARD, engine: ENGINE }), { code: 'DEVICE_WRAP_BINDING' });
});

test('keys.roster.each-roster-envelope-unwraps-to-the: clause 2: each roster envelope unwraps to the board key only with its own device private key; another roster device key refuses DEVICE_WRAP_AUTH [E16]', async () => {
  const { devices, roster } = await threeDevices();
  const key = crypto.getRandomValues(new Uint8Array(32));
  const envelopes = await wrapBoardKeyToRoster(key, roster, { board: BOARD, engine: ENGINE });
  for (const [index, device] of devices.entries()) {
    const expected = { board: BOARD, device: device.deviceId, engine: ENGINE };
    assert.deepEqual(await unwrapDeviceBoardKey(device.privateKey, envelopes[device.deviceId], expected), key);
    const other = devices[(index + 1) % devices.length];
    await assert.rejects(unwrapDeviceBoardKey(other.privateKey, envelopes[device.deviceId], expected), { code: 'DEVICE_WRAP_AUTH' });
    // Read as the other device's own envelope, the context check refuses it too.
    await assert.rejects(unwrapDeviceBoardKey(other.privateKey, envelopes[device.deviceId], { ...expected, device: other.deviceId }), { code: 'DEVICE_WRAP_AUTH' });
  }
});
