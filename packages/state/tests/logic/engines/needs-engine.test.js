/** @pullboard-test-input source-cell packages/state */
/** NEEDS_ENGINE is exported by the state front doors as one number above READINESS_ENGINE [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as full from '../../../index.js';
import * as light from '../../../light.js';

test('state.needs-engine.leaf-above-readiness: clause 1: NEEDS_ENGINE from packages/state/light.js and packages/state/index.js is the same number and is above READINESS_ENGINE [C7]', () => {
  assert.equal(typeof light.NEEDS_ENGINE, 'number', 'the light door exports NEEDS_ENGINE');
  assert.equal(full.NEEDS_ENGINE, light.NEEDS_ENGINE, 'both front doors read the same number');
  assert.ok(light.NEEDS_ENGINE > light.READINESS_ENGINE, `${light.NEEDS_ENGINE} is above READINESS_ENGINE ${light.READINESS_ENGINE}`);
});
