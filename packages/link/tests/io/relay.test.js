/** @pullboard-test-input source-cell link */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { gzipSync } from 'node:zlib';
import { decodeRelayRecord } from '../../src/io/relay/records.js';
import { sealRelayRecord } from '../../src/io/relay/records.js';
import { sealRelayPayload } from '../../src/io/relay/records.js';
import { unsealRelayRecord } from '../../src/io/relay/records.js';

const IO = new URL('../../src/io/', import.meta.url);
const KEY = Buffer.alloc(32, 7);
const STATE = { board: 'a'.repeat(32) };
const MOVE = { version: 1, engine: 1, id: 'move-7', event: { event_id: 7, kind: 'move' }, receipt: { outcome: { item_id: 19 } }, operation: 'addItem', args: [{ title: 'relay move' }] };

test('link.relay.stays-under-line-cap: relay.js and its sibling modules stay under the 1500-line cap [C7]', () => {
  for (const file of ['relay.js', 'relay/link.js', 'relay/device.js', 'relay/notices.js', 'relay/baseline.js']) {
    const lines = readFileSync(new URL(file, IO), 'utf8').split('\n').length;
    assert.ok(lines <= 1500, `${file} has ${lines} lines`);
  }
});

test('link.relay.exports-public-names: relay.js still exports the public names importers use [C7]', async () => {
  const relay = await import(new URL('relay.js', IO).href);
  for (const name of ['request', 'saveLink', 'localRecords', 'relayOperation', 'syncRelay', 'relayOn', 'relayOff',
    'relayDeviceRequest', 'revokeRelayPersonSession', 'relayRosterRead', 'relayMachineSignIn', 'DEFAULT_RELAY']) {
    assert.ok(name in relay, `${name} is exported`);
  }
});

test('link.io-relay.reads-gzip-and-legacy-moves: authenticated gzip and legacy moves preserve event and receipt content [H16,H17]', async () => {
  const sequence = 7;
  const plain = Buffer.from(JSON.stringify(MOVE));
  const gzipRecord = await sealRelayPayload(KEY, gzipSync(plain), STATE, 'move', sequence);
  const legacyRecord = await sealRelayPayload(KEY, plain, STATE, 'move', sequence);
  const [gzipMove, legacyMove] = await Promise.all([
    decodeRelayRecord(KEY, { sealed: gzipRecord }, STATE, 'move', sequence),
    decodeRelayRecord(KEY, { sealed: legacyRecord }, STATE, 'move', sequence),
  ]);
  assert.deepEqual(gzipMove, MOVE, 'the authenticated gzip move replays its complete event and receipt data');
  assert.deepEqual(legacyMove, MOVE, 'the legacy JSON move replays the same event and receipt data');
  assert.deepEqual(gzipMove, legacyMove, 'both encodings have identical replay content');
  const malformed = await sealRelayPayload(KEY, gzipSync(Buffer.from('{')), STATE, 'move', sequence);
  await assert.rejects(decodeRelayRecord(KEY, { sealed: malformed }, STATE, 'move', sequence), { code: 'RELAY_MOVE' });
  await assert.rejects(decodeRelayRecord(KEY, { sealed: gzipRecord }, STATE, 'move', sequence + 1), { code: 'SEAL_AUTH_FAILED' }, 'the sequence remains authenticated');
});

test('link.io-relay.move-writer-remains-plain: outbound moves stay plain while snapshots retain gzip [H16,H17]', async () => {
  const moveSealed = await sealRelayRecord(KEY, MOVE, STATE, 'move', 7);
  const movePlain = await unsealRelayRecord(KEY, { sealed: moveSealed }, STATE, 'move', 7);
  assert.deepEqual(Buffer.from(movePlain), Buffer.from(JSON.stringify(MOVE)), 'the actual move serializer seals ordinary JSON without gzip');
  const snapshot = { version: 1, tables: { event: [{ event_id: 7 }] } };
  const snapshotSealed = await sealRelayRecord(KEY, snapshot, STATE, 'snapshot', 7);
  const snapshotPlain = await unsealRelayRecord(KEY, { sealed: snapshotSealed }, STATE, 'snapshot', 7);
  assert.deepEqual([snapshotPlain[0], snapshotPlain[1]], [0x1f, 0x8b], 'snapshot compression is unchanged');
  assert.deepEqual(JSON.parse(gunzipSync(snapshotPlain).toString('utf8')), snapshot);
});
