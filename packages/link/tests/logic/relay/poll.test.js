/** Real device enrollment and key wraps; actual WebCrypto only [H5,H15,H17]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runFixtureChild as spawnSync } from '../../../../../apps/cli/tests/fixtures/child.js';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptDeviceEnrollment } from '../../../src/io/relay/machine.js';
import { beginDeviceEnrollment } from '../../../src/io/relay/machine.js';
import { readRelayMachine } from '../../../src/io/relay/machine.js';
import { removeRecordedDevice } from '../../../src/io/relay/machine.js';
import { wrapForRecordedDevice } from '../../../src/io/relay/machine.js';
import { createDeviceKeys } from '../../../../keys/index.js';
import { signDeviceEnrollment } from '../../../../keys/index.js';
import { unwrapDeviceBoardKey } from '../../../../keys/index.js';

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
  const module = new URL('../../../src/io/relay/machine.js', import.meta.url).href;
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
