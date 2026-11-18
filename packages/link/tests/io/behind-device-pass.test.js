/** @pullboard-test-input source-cell link config */
/** @pullboard-world-pin reads relay.js to prove its prepareEngineMove call passes the behind-device options. With engine.nameBehindDevice on, the relay move preparation passes the setting and the roster's engines to prepareEngineMove; off, it passes neither [H17,C7,#9828]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { behindDeviceOptions } from '../../src/io/relay/behind.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

const BOARD = 'a'.repeat(32);
const PHONE = 'device-' + '1'.repeat(32);
const REVOKED = 'device-' + '2'.repeat(32);

/** Serve fixed roster documents on a loopback port; return the link state a roster read needs and a closer. */
async function relay(answers) {
  const server = createServer((req, res) => {
    const body = answers[req.url];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'missing' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const state = { url: 'http://127.0.0.1:' + server.address().port, token: 'pm_' + 'x'.repeat(43), board: BOARD, machine: 'mac-self' };
  return { state, close: () => new Promise(done => server.close(done)) };
}

const ROSTER = {
  '/api/v1/devices': { version: 1, devices: [{ deviceId: PHONE, seen: 5, engine: 7 }, { deviceId: REVOKED, seen: 6, engine: 3, revoked: true }] },
  ['/auth/machines?board=' + BOARD]: { version: 1, machines: [
    { machine: 'mac-alpha', name: 'alpha', created: 1, seen: 2, engine: 9 },
    { machine: 'mac-beta', name: 'beta', created: 1, seen: 2 },
    { machine: 'mac-self', name: 'self', created: 1, seen: 2, engine: 4 },
  ] },
};

/** Run `body` with a private machine home whose settings are `settings`. */
async function withSettings(settings, body) {
  const { root: home } = privateFixtureFiles('pullboard-behind-');
  fixtureMachineSettings(home, settings);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { return await body(); }
  finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
}

test('link.behind-device.on-passes-roster: clause 1: with engine.nameBehindDevice on, behindDeviceOptions returns nameBehindDevice true and a behindDevices list of device, seat and engine from the roster [H17,#9828]', async () => {
  const { state, close } = await relay(ROSTER);
  try {
    const options = await withSettings({ engine: { nameBehindDevice: true } }, () => behindDeviceOptions(state));
    assert.deepEqual(options, { nameBehindDevice: true, behindDevices: [
      { device: 'alpha', seat: 'mac-alpha', engine: 9 },
      { device: 'phone ' + '1'.repeat(8), seat: PHONE, engine: 7 },
    ] });
  } finally { await close(); }
});

test('link.behind-device.roster-fault-empty: clause 1: a roster fault leaves the options empty instead of failing the move [H17,#9828]', async () => {
  const { state, close } = await relay({});
  try {
    const options = await withSettings({ engine: { nameBehindDevice: true } }, () => behindDeviceOptions(state));
    assert.deepEqual(options, { nameBehindDevice: true, behindDevices: [] });
    assert.deepEqual(await withSettings({ engine: { nameBehindDevice: true } }, () => behindDeviceOptions({ ...state, url: 'http://127.0.0.1:1' })), { nameBehindDevice: true, behindDevices: [] });
  } finally { await close(); }
});

test('link.behind-device.off-reads-nothing: clause 2: with the setting off or unset behindDeviceOptions passes neither option and never reads the roster [H17,#9828]', async () => {
  const { state, close } = await relay(ROSTER);
  try {
    assert.deepEqual(await withSettings({}, () => behindDeviceOptions(state)), {});
    assert.deepEqual(await withSettings({ engine: { nameBehindDevice: false } }, () => behindDeviceOptions({ ...state, url: 'http://127.0.0.1:1' })), {});
  } finally { await close(); }
});

test('link.behind-device.relay-spreads-options: clause 2: the prepareEngineMove call in relay.js spreads the behind-device options into its arguments [H17,#9828]', () => {
  const source = readFileSync(new URL('../../src/io/relay.js', import.meta.url), 'utf8');
  assert.match(source, /behind = await behindDeviceOptions\(state\)/u);
  assert.match(source, /prepareEngineMove\(board, operation, sent,\s*\{ \.\.\.\(.*\), \.\.\.behind \}\)/u);
});
