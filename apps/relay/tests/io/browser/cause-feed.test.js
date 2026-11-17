/** The browser client feeds the relay status after each exclusion load, so a refused read names its cause [H5,H17,C7,#9667]. @pullboard-test-input source-cell apps/relay */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { afterEach } from 'node:test';
import { test } from 'node:test';
import { createDeviceKeys } from '../../../../../packages/keys/index.js';
import { wrapDeviceBoardKey } from '../../../../../packages/keys/index.js';
import { seal } from '../../../../../packages/kernel/index.js';
import { installBrowserTransport } from '../../fixtures/browser-transport.js';
import { registerBrowserAliases } from '../../fixtures/browser-transport.js';
import { setRelayStatus } from '../../../src/io/browser/status.js';

registerBrowserAliases();
const { createTransport } = await import('../../../src/io/browser/client.js');

const BOARD = '0123456789abcdef0123456789abcdef';
const OPEN = 'corey/quant';
const MACHINE = 'machine-cause-fixture';
const ENGINE = 1;
const BOARDS = { version: 1, boards: [{ id: BOARD, repository: OPEN }] };
const APPROVALS = { version: 1, links: [] };

afterEach(() => setRelayStatus(null));

/** Put one device record in the stand-in IndexedDB, as an enrolled phone browser has. */
async function storeDevice(device) {
  const db = await new Promise((resolve) => { const request = globalThis.indexedDB.open('pullboard-relay-device-v1', 1); request.onsuccess = () => resolve(request.result); });
  await new Promise((resolve) => {
    const transaction = db.transaction('keys', 'readwrite');
    transaction.objectStore('keys').put(device, 'device');
    transaction.oncomplete = resolve;
  });
}

/** Load the client, then fail the next read, and return what the refusal carried. */
async function refusedAfterLoad(responses) {
  const transport = await createTransport();
  responses['/api/v1/boards'] = { status: 502, body: {} };
  try { await transport.request('/api/v1/boards'); } catch (error) { return error; }
  assert.fail('the stubbed read should have been refused');
}

test('clause 1: after the client loads an excluded-board list naming the open board, a failed read refuses with relayCause excluded [C7,#9667]', async () => {
  const phone = await createDeviceKeys();
  const device = { ...phone, account: '7', locator: 'a'.repeat(22) };
  const id = 'f'.repeat(32);
  const key = new Uint8Array(randomBytes(32));
  const plain = new TextEncoder().encode(JSON.stringify({ account: '7', machine: MACHINE, label: 'Fixture computer', names: [OPEN] }));
  const sealed = Buffer.from(await seal(key, plain, { boardId: id, kind: 'snapshot', sequence: 0 })).toString('base64url');
  const envelope = await wrapDeviceBoardKey(key, phone.publicKey, { board: id, device: phone.deviceId, engine: ENGINE });
  const responses = {
    '/api/v1/boards': BOARDS,
    '/api/v1/devices/approvals': APPROVALS,
    '/api/v1/devices/session': { version: 1, account: '7' },
    '/api/v1/devices/exclusions': { version: 1, exclusions: [{ machine: MACHINE, label: 'Fixture computer', count: 1 }] },
    ['/api/v1/devices/' + phone.deviceId + '/boards']: { version: 1, wraps: [] },
    ['/api/v1/devices/' + phone.deviceId + '/exclusions']: { version: 1, exclusions: [{ machine: MACHINE, engine: ENGINE, id,
      wrapped: Buffer.from(JSON.stringify(envelope)).toString('base64url'), sealed }] },
  };
  const stand = installBrowserTransport({ responses });
  try {
    await storeDevice(device);
    const error = await refusedAfterLoad(responses);
    assert.equal(error.code, 'RELAY_UNAVAILABLE');
    assert.equal(error.relayCause?.cause, 'excluded');
  } finally { stand.restore(); }
});

test('clause 2: after the client loads an empty exclusion list, a failed read refuses with no relayCause [C7,#9667]', async () => {
  const responses = {
    '/api/v1/boards': BOARDS,
    '/api/v1/devices/approvals': APPROVALS,
    '/api/v1/devices/exclusions': { version: 1, exclusions: [] },
  };
  const stand = installBrowserTransport({ responses });
  try {
    const error = await refusedAfterLoad(responses);
    assert.equal(error.code, 'RELAY_UNAVAILABLE');
    assert.equal(error.relayCause, undefined);
  } finally { stand.restore(); }
});
