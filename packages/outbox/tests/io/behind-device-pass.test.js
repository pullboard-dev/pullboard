/** @pullboard-test-input source-cell outbox link config */
/** @pullboard-world-pin reads relay.js to prove its prepareEngineMove call passes the behind-device options. With engine.nameBehindDevice on, the outbox move preparation passes the setting and the roster's engines to prepareEngineMove; off, it passes neither [H17,C7,#9829]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { behindDeviceOptions } from '../../../link/index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

const BOARD = 'a'.repeat(32);

/** Serve a fixed roster on a loopback port; return the link state a roster read needs and a closer. */
async function relay() {
  const answers = {
    '/api/v1/devices': { version: 1, devices: [] },
    ['/auth/machines?board=' + BOARD]: { version: 1, machines: [{ machine: 'mac-alpha', name: 'alpha', created: 1, seen: 2, engine: 9 }] },
  };
  const server = createServer((req, res) => {
    const body = answers[req.url];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'missing' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const state = { url: 'http://127.0.0.1:' + server.address().port, token: 'pm_' + 'x'.repeat(43), board: BOARD, machine: 'mac-self' };
  return { state, close: () => new Promise(done => server.close(done)) };
}

/** Run `body` with a private machine home whose settings are `settings`. */
async function withSettings(settings, body) {
  const { root: home } = privateFixtureFiles('pullboard-outbox-behind-');
  fixtureMachineSettings(home, settings);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { return await body(); }
  finally {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  }
}

const source = readFileSync(new URL('../../src/io/relay.js', import.meta.url), 'utf8');

test('clause 1: with engine.nameBehindDevice on, the options the outbox passes carry nameBehindDevice and the roster behindDevices [H17,#9829]', async () => {
  const { state, close } = await relay();
  try {
    const options = await withSettings({ engine: { nameBehindDevice: true } }, () => behindDeviceOptions(state));
    assert.deepEqual(options, { nameBehindDevice: true, behindDevices: [{ device: 'alpha', seat: 'mac-alpha', engine: 9 }] });
  } finally { await close(); }
});

test('clause 1: queueMove in outbox relay.js hands those options to prepareEngineMove [H17,#9829]', () => {
  assert.match(source, /behind = await behindDeviceOptions\(state\)/u);
  assert.match(source, /prepareEngineMove\(board, operation, sent, behind\)/u);
});

test('clause 2: with the setting off or unset the outbox passes neither option and never reads the roster [H17,#9829]', async () => {
  const { state } = await relay().then(async made => { await made.close(); return made; });
  assert.deepEqual(await withSettings({}, () => behindDeviceOptions(state)), {});
  assert.deepEqual(await withSettings({ engine: { nameBehindDevice: false } }, () => behindDeviceOptions(state)), {});
});
