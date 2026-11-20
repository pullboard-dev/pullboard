/** @pullboard-test-input source-cell packages/state */
/** prepareEngineMove names the teammate device that is behind in its ENGINE_VERSION refusal, behind engine.nameBehindDevice [C7,#9418]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareEngineMove } from '../../../src/io/engine.js';
import { ENGINE_VERSION } from '../../../src/io/machine.js';

const needed = ENGINE_VERSION + 50;
const releases = [{ engine: 1, release: '0.9.2' }, { engine: ENGINE_VERSION, release: '0.9.4' }, { engine: needed, release: '0.9.5' }];

/** A board whose only operation needs a newer engine than this one; the move table is never reached. `probe` is no registry operation, so the grant check passes it; its store writer exists, so NO_STORE_WRITER does not stop it first. */
const board = { enginePorts: { store: { probe() {} }, registry: {}, operations: ['probe'], minimumOperationEngine: () => needed } };
const refusal = options => {
  try { prepareEngineMove(board, 'probe', [], options); } catch (error) { return error; }
  return assert.fail('the move was not refused');
};
const devices = [{ device: 'studio-mac', seat: 'core-12', engine: 20 }, { device: 'laptop', seat: 'core-3', engine: 10 }, { device: 'current', seat: 'core-4', engine: needed }];

test('state.io-engine-behind-refusal.clause-1-with-the-setting-on-the-refusal: clause 1: with the setting on the refusal keeps ENGINE_VERSION and names the device with the lowest engine below the needed one [C7,#9418]', () => {
  const error = refusal({ nameBehindDevice: true, behindDevices: devices, releases });
  assert.equal(error.code, 'ENGINE_VERSION');
  assert.match(error.message, /laptop \(seat core-3\)/u);
  assert.match(error.message, /Pullboard 0\.9\.5/u);
  assert.match(error.message, /pullboard update on laptop/u);
  assert.doesNotMatch(error.message, /studio-mac|current/u);
});

test('state.io-engine-behind-refusal.clause-2-with-the-setting-off-or-no: clause 2: with the setting off, or no device below the needed engine, the refusal text is unchanged [C7,#9418]', () => {
  const plain = refusal({});
  assert.equal(plain.code, 'ENGINE_VERSION');
  assert.equal(plain.message, `[ENGINE_VERSION] probe requires engine version ${needed}; this pullboard uses engine ${ENGINE_VERSION}; upgrade before sending it`);
  assert.equal(refusal({ nameBehindDevice: false, behindDevices: devices, releases }).message, plain.message);
  assert.equal(refusal({ nameBehindDevice: true, behindDevices: [], releases }).message, plain.message);
  assert.equal(refusal({ nameBehindDevice: true, behindDevices: [devices[2]], releases }).message, plain.message);
});
