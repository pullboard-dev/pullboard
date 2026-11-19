/** @pullboard-test-input source-cell packages/state */
/** BLOCK_ENGINE is exported by both state doors as one number above RESERVATION_ENGINE [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as full from '../../../index.js';
import * as light from '../../../light.js';

test('state.block-engine.leaf-exported: clause 1: BLOCK_ENGINE from packages/state/light.js and packages/state/index.js is the same number and is above RESERVATION_ENGINE [C7]', () => {
  assert.equal(typeof light.BLOCK_ENGINE, 'number', 'the light door exports BLOCK_ENGINE');
  assert.equal(light.BLOCK_ENGINE, full.BLOCK_ENGINE, 'both doors give one number');
  assert.ok(light.BLOCK_ENGINE > light.RESERVATION_ENGINE, `${light.BLOCK_ENGINE} is above RESERVATION_ENGINE ${light.RESERVATION_ENGINE}`);
});
