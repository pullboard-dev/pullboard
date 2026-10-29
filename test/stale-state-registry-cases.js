/** Additive stale maintenance contracts never rewrite the engine107 registry snapshot [B4,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MOVE_REGISTRY, minimumMoveEngine } from '../src/move-registry.js';
import { nativeBoardPorts } from '../src/native-board.js';
const { relayMoveActor } = nativeBoardPorts().enginePorts;
import { STALE_STATE_ENGINE } from '../src/stale-state-engine.js';

export const STALE_STATE_OPERATIONS = Object.freeze(['maintainStaleState']);
export const STALE_STATE_STEPS = Object.freeze({
  COORDINATOR_ONLY: 'ask the coordinator to do it: pullboard shout coordinator --kind question "<what you need>"',
  ENGINE_VERSION: 'upgrade Pullboard: npm install -g pullboard@latest',
  STALE_STATE_CHANGED: 'capture the current hold and reservation state again before releasing anything',
  BAD_STALE_STATE: 'capture a complete current stale-state observation with pullboard sentinel run',
});

/** Exercise only the new operation while historical actor vectors and replay remain pinned separately. */
export function installStaleStateRegistryCases() {
  test('stale maintenance binds its options actor and its replay-aware floor [B4,H16]', () => {
    assert.equal(MOVE_REGISTRY.maintainStaleState.itemIdFirstArgument, false);
    assert.equal(minimumMoveEngine('maintainStaleState', []), STALE_STATE_ENGINE);
    assert.equal(relayMoveActor({ operation: 'maintainStaleState', args: [{ agentId: 'coordinator' }] }), 'coordinator');
    assert.equal(relayMoveActor({ operation: 'maintainStaleState', args: [7, { agentId: 'wrong-slot' }] }), null);
    assert.equal(relayMoveActor({ operation: 'maintainStaleState', args: [] }), null);
    assert.deepEqual(MOVE_REGISTRY.maintainStaleState.nextSteps, STALE_STATE_STEPS);
  });
}
