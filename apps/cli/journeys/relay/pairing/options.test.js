/** Additional browser options retain CLI types, enrollment idempotence and cancellation [H15,H17]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import { createDeviceKeys } from '../../../../../packages/keys/index.js';
import { signDeviceEnrollment } from '../../../../../packages/keys/index.js';

/** Observe real enrollment state and optional foreground output before acting on the owned child. */
async function enrollment(file, command, ready = '') {
  const until = Date.now() + command.deadlineMs;
  while (Date.now() < until) {
    const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (state?.pending && (!ready || command.stdout.includes(ready))) return state.pending;
    if (command.child.exitCode !== null || command.child.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('the real foreground enrollment did not become ready');
}

/** Enroll a signed supplemental protocol device; the separate acceptance test uses two real browsers. */
async function firstDevice(box, file) {
  const command = box.startCli(['relay', 'on', '--all', '--url', box.origin]);
  const pending = await enrollment(file, command);
  const published = await box.waitForResponse('/api/v1/devices/enrollments/' + pending.locator);
  assert.equal(published.method, 'POST', 'native enrollment publication completes before the protocol device answers');
  const headers = { authorization: 'Bearer ' + (await box.phoneSession()).token, 'content-type': 'application/json' };
  const identity = await (await fetch(box.origin + '/api/v1/devices/session', { headers })).json();
  const keys = await createDeviceKeys();
  const body = await signDeviceEnrollment(pending.secret, { v: 1, account: identity.account, locator: pending.locator,
    deviceId: keys.deviceId, publicKey: keys.publicKey, label: 'Protocol compatibility device', createdAt: new Date().toISOString() });
  const response = await fetch(box.origin + '/api/v1/devices/enrollments/' + pending.locator,
    { method: 'PUT', headers, body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  assert.equal((await command.closed).code, 0);
  return keys.deviceId;
}

test('the additional-browser flag preserves string options and refuses unrelated relay moves [H17]', async t => {
  const box = await relayClientFixture(t);
  const file = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const calls = box.calls.length;
  for (const args of [['relay', 'recover', '--skip', '1'], ['relay', 'on', '--all'], ['relay', 'devices']]) {
    const result = await box.cliLocal(...args, '--new-browser');
    assert.equal(result.code, 1);
    assert.equal(result.document.error.code, 'USAGE');
  }
  assert.equal(box.calls.length, calls, 'misused flags do not reach relay endpoints');
  assert.equal(existsSync(file) ? readFileSync(file, 'utf8') : null, before, 'misused flags do not mutate machine state');
  const help = await box.startCli(['relay', '--help', '--browser=2'], {}, { json: false }).closed;
  assert.equal(help.code, 0, 'the existing browser option still accepts a string value');
  const missing = await box.startCli(['relay', '--browser'], {}, { json: false }).closed;
  assert.equal(missing.code, 2, 'the existing string option still requires its value');
  assert.match(missing.stderr, /--browser.*argument missing/iu);
  assert.match(help.stdout, /relay pair --new-browser/u);
});

test('repeat setup retains its device and cancelling another browser names the fresh pairing command [H15,H17]', async t => {
  const box = await relayClientFixture(t);
  const file = join(box.env.PULLBOARD_HOME, 'relay-machine/state.json');
  const device = await firstDevice(box, file);
  const before = JSON.parse(readFileSync(file, 'utf8')).devices;
  const enrollments = box.calls.filter(call => call.method === 'POST' && call.path.startsWith('/api/v1/devices/enrollments/')).length;
  assert.ok(enrollments > 0, 'the initial real enrollment was observed before testing idempotence');
  const repeated = await box.cliLocal('relay', 'on', '--all');
  assert.equal(repeated.code, 0);
  assert.equal(box.calls.filter(call => call.method === 'POST' && call.path.startsWith('/api/v1/devices/enrollments/')).length, enrollments);
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).devices, before);
  const additional = box.startCli(['relay', 'pair', '--new-browser'], {}, { json: false });
  const pending = await enrollment(file, additional, 'Now waiting for another browser');
  assert.ok(pending.locator, 'a real additional enrollment exists before cancellation');
  assert.equal(additional.child.kill('SIGINT'), true, 'only this exact owned foreground child receives SIGINT');
  const stopped = await additional.closed;
  assert.equal(stopped.code, 0);
  assert.match(stopped.stdout, /Run pullboard relay pair --new-browser for a fresh code/u);
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.pending, null);
  assert.deepEqual(after.devices, before, 'cancellation retains the first device exactly');
  assert.equal(after.devices[0].deviceId, device);
  assert.equal((await box.cliLocal('relay', 'pair')).code, 0, 'bare pairing still creates a computer-clone bundle');
});
