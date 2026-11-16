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

/** A board stub with this slice, a sibling slice of the same parent that owns web/api, and the sibling's holder. */
const siblingBoard = () => ({ db: { prepare: sql => ({
  get: key => (sql.includes('FROM item ') ? { item_owner: 'core-7' } : { meta_value: JSON.stringify({ parentId: 5, files: ['web/view.js'] }) }),
  all: () => [{ meta_key: 'item-slice:78', meta_value: JSON.stringify({ parentId: 5, files: ['web/api'] }) },
    { meta_key: 'item-slice:79', meta_value: JSON.stringify({ parentId: 9, files: ['web/other'] }) }],
}) } });

test('clause 1: the slices.enforcePaths refusal for a path a sibling slice owns names that sibling and its owner [C7,B26]', () => {
  assert.throws(() => requireSlicePaths(siblingBoard(), item, ['web/api/x.js'], true), /SLICE_PATHS.*web\/api\/x\.js.*sibling slice #78.*core-7/u);
  assert.throws(() => requireSlicePaths(siblingBoard(), item, ['web/other/y.js'], true), error => !/sibling/u.test(error.message));
});
