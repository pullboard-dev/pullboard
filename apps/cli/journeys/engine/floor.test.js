/** @pullboard-test-input source-cell packages/state packages/link */
/** A move blocked by a teammate's device on an older engine names that device, the releases and the one fix command [H16,H17,C7,#1305]. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { behindDeviceOptions } from '../../../../packages/link/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';

const BOARD = 'a'.repeat(32);
const NEEDED = ENGINE_VERSION + 50;
const RELEASES = [{ engine: 1, release: '0.9.2' }, { engine: ENGINE_VERSION, release: '0.9.4' }, { engine: NEEDED, release: '0.9.5' }];

/** Serve a fixed roster on a loopback port, as the relay does; return the link state a roster read needs and a closer. */
async function relay(machines) {
  const answers = { '/api/v1/devices': { version: 1, devices: [] }, [`/auth/machines?board=${BOARD}`]: { version: 1, machines } };
  const server = createServer((req, res) => {
    const body = answers[req.url];
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'missing' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const state = { url: `http://127.0.0.1:${server.address().port}`, token: `pm_${'x'.repeat(43)}`, board: BOARD, machine: 'mac-self' };
  return { state, close: () => new Promise(done => server.close(done)) };
}

/** A board whose only operation needs a newer engine than this one; the move table is never reached. `probe` is no registry operation, so the grant check passes it. */
const board = { enginePorts: { store: {}, registry: {}, operations: ['probe'], minimumOperationEngine: () => NEEDED } };

/** The refusal prepareEngineMove raises for the roster the relay serves, built as the outbox builds it. */
async function refusalFor(machines) {
  const { state, close } = await relay(machines);
  try {
    const behind = await behindDeviceOptions(state, { enabled: () => true });
    try { prepareEngineMove(board, 'probe', [], { ...behind, releases: RELEASES }); } catch (error) { return error; }
    return assert.fail('the move was not refused');
  } finally { await close(); }
}

test("clause 1: a move blocked by a teammate's old engine names them and the fix [H16,H17,C7,#1305]", async () => {
  const error = await refusalFor([
    { machine: 'mac-studio', name: 'studio', created: 1, seen: 2, engine: 20 },
    { machine: 'mac-laptop', name: 'laptop', created: 1, seen: 2, engine: 10 },
    { machine: 'mac-current', name: 'current', created: 1, seen: 2, engine: NEEDED },
  ]);
  assert.equal(error.code, 'ENGINE_VERSION');
  assert.match(error.message, /laptop \(seat mac-laptop\)/u, 'it names the device and the seat');
  assert.match(error.message, /runs Pullboard 0\.9\.2/u, 'it names the version they run');
  assert.match(error.message, /needs Pullboard 0\.9\.5/u, 'it names the version needed');
  assert.match(error.message, /run pullboard update on laptop/u, 'it names the one command that fixes it');
  assert.doesNotMatch(error.message, /studio|current|engine version|engine \d+/u, 'it names no other device and no bare engine number');
});
