// pullboard: browser
/** @pullboard-test-gui */
/** A private board is usable through its actual LAN address, with explicit pairing authority [H19]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromeExecutable } from '../../tests/fixtures/cockpit/harness.js';
import { closeSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { fetchLive } from '../../tests/fixtures/cockpit/harness.js';
import { machine } from '../../tests/fixtures/cockpit/harness.js';
import { openSnapshotChrome } from '../../tests/fixtures/cockpit/harness.js';
import { project } from '../../tests/fixtures/cockpit/harness.js';
import { startView } from '../../tests/fixtures/cockpit/harness.js';
import { assertLanRefusal } from '../../tests/fixtures/cockpit/lan.js';
import { lanBoundaryReply } from '../../tests/fixtures/cockpit/lan.js';
import { startLanView } from '../../tests/fixtures/cockpit/lan.js';
import { viewLanAddress } from '../../../view/index.js';

test('clause 1: a phone reaches the board on the local network [H19]', { timeout: 180_000 }, async t => { // budget: one real private board, two owned view listeners and a mobile Chrome session.
  t.diagnostic('runtime ' + JSON.stringify({ node: process.version, sqlite: process.versions.sqlite,
    executable: process.execPath, binarySha256: createHash('sha256').update(readFileSync(process.execPath)).digest('hex') }));
  const box = machine();
  const alpha = project(box, 'private-lan-fixture');
  const title = 'LAN fixture obligation';
  box.run(alpha.repo, 'add', 'web', title, '--specs', 'G1', '--criterion', 'remains visible to its paired person');
  const view = await startLanView(t, box);
  const assigned = Object.values(networkInterfaces()).flat().filter(row => row && row.family === 'IPv4' && !row.internal)
    .map(row => row.address);
  assert.ok(assigned.includes(view.link.hostname), 'the printed link names an assigned non-loopback interface');
  assert.ok(view.key && view.key.length >= 24, 'the pairing code has at least 144 bits of random capacity');
  assert.notEqual(view.link.hostname, '0.0.0.0', 'a wildcard bind is never printed as a usable address');

  const headers = { 'x-pullboard-key': view.key };
  const boardsReply = await fetchLive(view.base + '/api/v1/boards', { headers });
  assert.equal(boardsReply.status, 200, 'the authenticated API answers on the actual LAN interface');
  const boards = (await boardsReply.json()).boards;
  assert.deepEqual(boards.map(board => board.root), [alpha.repo], 'only the private fixture is exposed');
  for (const [path, requestHeaders] of [
    ['/', {}], ['/api/v1/boards', {}], ['/?k=invalid-fixture-code', {}],
    ['/api/v1/boards', { 'x-pullboard-key': 'invalid-fixture-code' }],
    ['/', { ...headers, host: 'foreign.invalid:' + view.link.port }],
    ['/api/v1/boards', { ...headers, host: 'foreign.invalid:' + view.link.port }],
    ['/', { ...headers, origin: 'https://foreign.invalid' }],
    ['/api/v1/boards', { ...headers, origin: 'https://foreign.invalid' }],
    ['/local/view', {}], ['/local/connect', {}],
  ]) assertLanRefusal(await lanBoundaryReply(view, path, requestHeaders), view, title);

  const executable = chromeExecutable();
  assert.ok(executable, 'real Chrome is required for the mobile LAN view');
  const profile = mkdtempSync(join(tmpdir(), 'pullboard-lan-chrome-'));
  let chrome;
  t.after(async () => { if (chrome) await closeSnapshotChrome(chrome); rmSync(profile, { recursive: true, force: true }); });
  chrome = await openSnapshotChrome(executable, view.link.href, profile);
  await chrome.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
  // A fresh board opens on the first-run Dashboard (0de17112c6); set it aside so the board's own work shows.
  await chrome.waitFor('innerWidth === 375 && !!data?.project');
  await chrome.stable("(() => { keep('pb.firstrun.' + view.root, 'hidden'); render(); return true; })()");
  await chrome.waitFor(`innerWidth === 375 && document.body.innerText.includes(${JSON.stringify(title)})`);
  assert.equal(await chrome.stable('location.hostname'), view.link.hostname, 'the browser uses the LAN address, not a loopback stand-in');
  await chrome.click('document.querySelector(\'[data-tab="shouts"]\')');
  const message = 'LAN fixture person request';
  await chrome.stable(`document.querySelector('#shout-text').value = ${JSON.stringify(message)}`);
  await chrome.click("document.querySelector('#shout-send')");
  await chrome.waitFor(`document.querySelector('#shout-text').value === '' && document.body.innerText.includes(${JSON.stringify(message)})`);
  const native = JSON.parse(box.run(alpha.repo, 'export', '--json'));
  const recorded = native.tables.shout.filter(row => row.shout_text === message)
    .map(({ shout_from, shout_to, shout_request }) => ({ shout_from, shout_to, shout_request }));
  assert.deepEqual(recorded, [{ shout_from: 'person', shout_to: 'coordinator', shout_request: 1 }],
    'the mobile action is a real native person request, recorded exactly once');
  assert.equal(await chrome.stable('document.documentElement.scrollWidth <= document.documentElement.clientWidth'), true,
    'the phone view stays within its viewport');

  const local = await startView(box);
  t.after(() => local.stop());
  assert.equal(local.link.hostname, '127.0.0.1', 'ordinary view still starts as loopback only');
  const localForeign = await lanBoundaryReply({ ...local, base: local.base }, '/api/v1/boards', {
    'x-pullboard-key': local.key, host: view.link.hostname + ':' + local.link.port,
  });
  assertLanRefusal(localForeign, local, title);
  t.diagnostic('Real LAN-interface HTTP and 375px Chrome; both clients run on this machine, not a second physical phone.');
});

test('LAN mode selects one private interface and refuses when none is assigned [H19]', () => {
  const row = (address, internal = false, family = 'IPv4') => ({ address, internal, family });
  const interfaces = {
    lo0: [row('127.0.0.1', true)],
    en0: [row('2001:db8::1', false, 'IPv6'), row('192.168.7.9')],
    utun0: [row('10.2.3.4')],
  };
  const before = structuredClone(interfaces);
  assert.equal(viewLanAddress(interfaces), '192.168.7.9', 'an assigned physical private interface wins over the tunnel');
  assert.deepEqual(interfaces, before, 'address selection does not rewrite OS interface data');
  assert.throws(() => viewLanAddress({ lo0: [row('127.0.0.1', true)], en0: [row('203.0.113.5')] }),
    error => error.code === 'LAN_UNAVAILABLE' && error.message.includes('local IPv4') && error.next.includes('pullboard view --lan'),
    'no wildcard or public listener is used when a private IPv4 interface is unavailable');
});
