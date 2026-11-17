import { viewApiPorts } from '../../../../../view/index.js';
/** Complete authenticated HTTP and pinned API2 reader oracle [H5,H16,A2]. */
import { apiBoardOpeners } from '../../board.js';

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { serveApi } from '../../../../../../packages/api/index.js';
import { refusalDocument } from '../../../../index.js';
import { main } from '../../native.js';
import { ENGINE_VERSION } from '../../../../../../packages/state/index.js';
import { openPagedSnapshot } from '../../../../../../packages/pages/index.js';
import { snapshotState } from '../../../../../relay/index.js';

/** Deliberate machine-local differences; all other fields retain complete reader parity. */
export const LOCAL_PARITY_FIELDS = Object.freeze([
  { path: 'root', reason: 'Native routing uses a local repository directory; a relay reader routes by persistent board id.' },
  { path: 'relayHealthAlerts', relayAbsent: true, reason: 'Canary observations are private telemetry on this local client, never sealed board state.' },
  { path: 'capacityForecast', reason: 'The forecast reads a machine-local derived proof-counter index, which sealed exports omit; only the local host serves it.' },
  { path: 'idleMinutes', anySuffix: true, reason: 'A sealed state carries lastActivity and the relay page derives idle minutes from it, so no sealed build holds a clock reading [C7].' },
  { path: 'needs', kind: 'relay-health', relayAbsent: true, reason: 'Only Needs derived from this local client canary stay on that client.' },
]);

/** Report the first undeclared field difference with both actual values, including missing keys. */
export function assertReaderParity(native, relay, localFields = LOCAL_PARITY_FIELDS) {
  const ignored = new Set(localFields.filter(entry => !entry.kind && !entry.anySuffix).map(entry => entry.path));
  const suffixes = localFields.filter(entry => entry.anySuffix).map(entry => '.' + entry.path);
  assert.ok(localFields.every(entry => entry.path && entry.reason?.trim()), 'every local-only field has a reason');
  /** Compare structure as well as values; a missing field is never equivalent to an explicit null. */
  function compare(left, right, path) {
    if (suffixes.some(suffix => path.endsWith(suffix))) return;
    if (ignored.has(path)) {
      const absent = localFields.some(entry => entry.path === path && entry.relayAbsent);
      if (absent) assert.ok(right === undefined || (Array.isArray(right) && right.length === 0), `reader parity ${path}: machine-only field leaked to the relay side: ${JSON.stringify(right)}`);
      return;
    }
    const localKinds = localFields.filter(entry => entry.path === path && entry.kind).map(entry => entry.kind);
    if (localKinds.length && Array.isArray(left) && Array.isArray(right)) {
      const leaked = right.filter(entry => localKinds.includes(entry.kind) && localFields.some(field => field.path === path && field.kind === entry.kind && field.relayAbsent));
      assert.equal(leaked.length, 0, `reader parity ${path}: machine-only entry leaked to the relay side: ${JSON.stringify(leaked)}`);
      left = left.filter(entry => !localKinds.includes(entry.kind));
      right = right.filter(entry => !localKinds.includes(entry.kind));
    }
    const label = value => value === undefined ? '<missing>' : JSON.stringify(value);
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
      assert.deepEqual(left, right, `reader parity ${path}: native=${label(left)} relay=${label(right)}`);
      return;
    }
    assert.equal(Array.isArray(left), Array.isArray(right), `reader parity ${path}: native=${label(left)} relay=${label(right)}`);
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) compare(left[key], right[key], path ? `${path}.${key}` : key);
  }
  compare(native, relay, '');
}

/** Retain both real service clients across native mutations without starting another CLI process. */
export async function createParityReader({ root, origin, token, boardId, key, projects = () => [{ root, name: 'parity' }] }) {
  let observedAt = Date.now();
  const secret = randomBytes(24).toString('base64url');
  const api = await serveApi({ viewPorts: viewApiPorts, boardOpeners: apiBoardOpeners, refusalDocument, secret, runCommand: main, projects, isMain: true, stateDetail: 'full', scope: { projectRoot: root }, now: () => observedAt });
  /** Read the current exact sealed clock, then ask the complete native HTTP API at that clock. */
  async function read() {
    /** Request through a distinct authenticated person session, never a direct journal read. */
    async function request(path) {
      const response = await fetch(origin + path, { headers: { authorization: `Bearer ${token}`, 'x-pullboard-engine': String(ENGINE_VERSION) } });
      assert.equal(response.status, 200, `relay parity reader GET ${path.split('?')[0]}`);
      return response.json();
    }
    const document = await request(`/api/v2/boards/${boardId}/state`);
    assert.equal(document.apiVersion, 2, 'current snapshot transport is exercised');
    const saved = document.state;
    const page = await openPagedSnapshot(saved.root, { key, boardId, sequence: saved.sequence,
      /** Fetch only the pinned, reachable sealed object graph through its actual service boundary. */
      async get(id, parents) {
        const object = await request(`/api/v2/boards/${boardId}/objects/${id}?pin=${encodeURIComponent(saved.read.id)}&via=${parents.join(',')}`);
        return Uint8Array.from(Buffer.from(object.page.sealed, 'base64url'));
      },
    }, { maxEngine: ENGINE_VERSION });
    const restored = await page.native();
    const relay = snapshotState(restored, boardId);
    observedAt = Date.parse(relay.observedAt);
    assert.ok(Number.isSafeInteger(observedAt), 'the sealed projection carries its explicit observation clock');
    const nativeResponse = await fetch(`http://127.0.0.1:${api.port}/api/v1/boards/${boardId}/state?detail=full`, { headers: { 'x-pullboard-key': secret } });
    assert.equal(nativeResponse.status, 200, 'complete native API state is available');
    const native = (await nativeResponse.json()).state;
    return { native, relay, restored };
  }
  return { read, close: api.close };
}
