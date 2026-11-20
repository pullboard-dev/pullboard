/** The relay device store replaces a board's wrap set in one step and touches no other board or account [H5,H15,C7,#6878]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { createDeviceStore } from '../../../src/io/store/device.js';

/** A private device store with two enrolled devices on each of two accounts, each holding a wrap for two boards. */
function fixture(t) {
  const directory = privateFixtureFiles('pullboard-device-').root;
  const devices = createDeviceStore({ directory });
  t.after(() => { devices.close(); rmSync(directory, { recursive: true, force: true }); });
  for (const account of ['account-1', 'account-2']) {
    for (const device of ['phone-a', 'phone-b']) {
      devices.register(account, device);
      for (const board of ['board-1', 'board-2']) devices.put(account, device, board, 1, `wrap-${account}-${device}-${board}`);
    }
  }
  return devices;
}

/** The board and wrapped value each device of an account reads, as a plain map. */
const held = (devices, account, device) => devices.wraps(account, device).map(row => `${row.board}:${row.engine}:${row.wrapped}`);

test('relay.io-store-device.replace-leaves-given-wraps: clause 1: replaceBoardWraps(account, board, wraps) leaves exactly the given device wraps for that board, so a device left out of the rotated set no longer reads a wrap [C7]', (t) => {
  const devices = fixture(t);
  devices.replaceBoardWraps('account-1', 'board-1', [{ device: 'phone-a', engine: 2, wrapped: 'rotated-a' }]);
  assert.deepEqual(held(devices, 'account-1', 'phone-a'), ['board-1:2:rotated-a', 'board-2:1:wrap-account-1-phone-a-board-2']);
  assert.deepEqual(held(devices, 'account-1', 'phone-b'), ['board-2:1:wrap-account-1-phone-b-board-2'], 'the device left out reads no wrap for the board');
  assert.deepEqual(devices.boardDevices('account-1', 'board-1').map(row => row.deviceId), ['phone-a']);
  assert.throws(() => devices.replaceBoardWraps('account-1', 'board-1', [{ device: 'phone-a', engine: 3, wrapped: 'x' }, { device: 'phone-unknown', engine: 3, wrapped: 'y' }]), error => error.code === 'DEVICE_NOT_ENROLLED');
  assert.deepEqual(held(devices, 'account-1', 'phone-a'), ['board-1:2:rotated-a', 'board-2:1:wrap-account-1-phone-a-board-2'], 'a refused set changes nothing');
  devices.replaceBoardWraps('account-1', 'board-1', []);
  assert.deepEqual(devices.boardDevices('account-1', 'board-1'), [], 'an empty set removes every wrap of the board');
});

test('relay.io-store-device.replace-changes-nothing-else: clause 2: replaceBoardWraps changes nothing for another board of the same account or for another account [C7]', (t) => {
  const devices = fixture(t);
  const before = ['phone-a', 'phone-b'].map(device => [held(devices, 'account-1', device), held(devices, 'account-2', device)]);
  devices.replaceBoardWraps('account-1', 'board-1', [{ device: 'phone-b', engine: 2, wrapped: 'rotated-b' }]);
  for (const device of ['phone-a', 'phone-b']) {
    assert.deepEqual(held(devices, 'account-2', device), before[device === 'phone-a' ? 0 : 1][1], `another account's ${device} is unchanged`);
    assert.deepEqual(held(devices, 'account-1', device).filter(row => row.startsWith('board-2:')), before[device === 'phone-a' ? 0 : 1][0].filter(row => row.startsWith('board-2:')), `another board of the same account is unchanged for ${device}`);
  }
});
