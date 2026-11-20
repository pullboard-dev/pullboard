/** @pullboard-test-input source-cell packages/state */
/** MERGED_AT_ENGINE is exported by both state doors as one number above BLOCK_ENGINE [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as full from '../../../index.js';
import * as light from '../../../light.js';

test('state.engines-merged-at.leaf-numbered: clause 1: MERGED_AT_ENGINE from packages/state/light.js and packages/state/index.js is the same number and is above BLOCK_ENGINE [C7]', () => {
  assert.equal(typeof light.MERGED_AT_ENGINE, 'number', 'the light door exports MERGED_AT_ENGINE');
  assert.equal(light.MERGED_AT_ENGINE, full.MERGED_AT_ENGINE, 'both doors give one number');
  assert.ok(light.MERGED_AT_ENGINE > light.BLOCK_ENGINE, `${light.MERGED_AT_ENGINE} is above BLOCK_ENGINE ${light.BLOCK_ENGINE}`);
});
