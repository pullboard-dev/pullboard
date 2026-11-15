/** @pullboard-test-input source-cell link */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const IO = new URL('../../src/io/', import.meta.url);

test('relay.js and its sibling modules stay under the 1500-line cap [C7]', () => {
  for (const file of ['relay.js', 'relay/link.js', 'relay/device.js', 'relay/notices.js', 'relay/baseline.js']) {
    const lines = readFileSync(new URL(file, IO), 'utf8').split('\n').length;
    assert.ok(lines <= 1500, `${file} has ${lines} lines`);
  }
});

test('relay.js still exports the public names importers use [C7]', async () => {
  const relay = await import(new URL('relay.js', IO).href);
  for (const name of ['request', 'saveLink', 'localRecords', 'relayOperation', 'syncRelay', 'relayOn', 'relayOff',
    'relayDeviceRequest', 'revokeRelayPersonSession', 'relayRosterRead', 'relayMachineSignIn', 'DEFAULT_RELAY']) {
    assert.ok(name in relay, `${name} is exported`);
  }
});
