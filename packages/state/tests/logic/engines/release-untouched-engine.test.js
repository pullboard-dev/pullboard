/** @pullboard-test-input source-cell packages/state */
/** The untouched-release reroute has its own engine number: older boards keep today's release decisions, newer ones count untouched hand-backs [C7,#2970]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ENGINE_VERSION } from '../../../light.js';
import { RELEASE_TWICE_ROUTE_ENGINE } from '../../../light.js';
import { RELEASE_UNTOUCHED_REROUTE_ENGINE as LIGHT_ENGINE } from '../../../light.js';
import { RELEASE_UNTOUCHED_REROUTE_ENGINE } from '../../../src/logic/engines/release-untouched-engine.js';

test('clause 1: the registry has an engine number for the untouched-release reroute, above the release-twice route engine [C7,#2970]', () => {
  assert.ok(Number.isInteger(RELEASE_UNTOUCHED_REROUTE_ENGINE) && RELEASE_UNTOUCHED_REROUTE_ENGINE > RELEASE_TWICE_ROUTE_ENGINE);
  assert.equal(LIGHT_ENGINE, RELEASE_UNTOUCHED_REROUTE_ENGINE, 'the state door forwards the leaf');
  assert.ok(ENGINE_VERSION >= RELEASE_UNTOUCHED_REROUTE_ENGINE, 'the registry version covers the new engine');
});
