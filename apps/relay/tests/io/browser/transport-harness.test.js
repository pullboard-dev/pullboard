/** The browser transport builds and loads one board inventory against in-memory stand-ins, with no network [H5,H15,C7]. @pullboard-test-input source-cell apps/relay */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installBrowserTransport } from '../../fixtures/browser-transport.js';
import { registerBrowserAliases } from '../../fixtures/browser-transport.js';

registerBrowserAliases();
const { createTransport } = await import('../../../src/io/browser/client.js');

const EMPTY = {
  '/api/v1/boards': { version: 1, boards: [] },
  '/api/v1/devices/approvals': { version: 1, links: [] },
  '/api/v1/devices/exclusions': { version: 1, exclusions: [] },
};

test('clause 1: createTransport resolves against stubbed fetch, localStorage and IndexedDB with no real network [H5,C7]', async () => {
  const stand = installBrowserTransport({ responses: EMPTY });
  try {
    const transport = await createTransport();
    assert.equal(typeof transport.request, 'function');
    const listed = await transport.request('/api/v1/boards');
    assert.deepEqual(listed.boards, []);
  } finally { stand.restore(); }
  assert.equal(typeof globalThis.indexedDB, 'undefined', 'restore removes the stand-ins');
});

test('clause 2: after one inventory load the stubbed fetch saw the exclusion list request [H5,C7]', async () => {
  const stand = installBrowserTransport({ responses: EMPTY });
  try {
    await createTransport();
    assert.ok(stand.requests.includes('/api/v1/boards'));
    assert.ok(stand.requests.includes('/api/v1/devices/exclusions'));
  } finally { stand.restore(); }
});
