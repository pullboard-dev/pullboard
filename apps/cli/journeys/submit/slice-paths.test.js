/** With slices.enforcePaths on, submit refuses a slice that changes a path outside its declared set; off by default [C7,B26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configFromSource } from '../../../../packages/config/light.js';
import { requireSlicePaths } from '../../src/io/submit/slice-paths.js';

/** A board stub holding the slice record `pullboard slice` writes under item-slice:<id>. */
const sliceBoard = files => ({ db: { prepare: () => ({ get: () => ({ meta_value: JSON.stringify({ files }) }) }) } });
const item = { item_id: 77 };

test('clause 1: with slices.enforcePaths on, submitting a slice that changes a path outside its declared set is refused [C7,B26]', () => {
  const config = configFromSource('{"slices":{"enforcePaths":true}}');
  const board = sliceBoard(['web/view.js', 'web/parts']);
  assert.doesNotThrow(() => requireSlicePaths(board, item, ['web/view.js', 'web/parts/a.js'], config.slices.enforcePaths));
  assert.throws(() => requireSlicePaths(board, item, ['web/view.js', 'api/other.js'], config.slices.enforcePaths), /SLICE_PATHS.*api\/other\.js/u);
});

test('clause 2: slices.enforcePaths defaults to off and the same submit then goes through [C7,B26]', () => {
  const config = configFromSource('{}');
  assert.equal(config.slices.enforcePaths, false);
  assert.doesNotThrow(() => requireSlicePaths(sliceBoard(['web/view.js']), item, ['web/view.js', 'api/other.js'], config.slices.enforcePaths));
});
