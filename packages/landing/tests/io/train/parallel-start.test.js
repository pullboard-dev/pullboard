/** @pullboard-test-input source-cell packages/landing */
/** With landing.parallelGates on, the start decision names the gates of disjoint items together and never overlapping ones [B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startGroup } from '../../../src/io/train/parallel-start.js';

const item = (id, files, tests) => ({ id, files, tests });

test('landing.parallel-start.disjoint-items-start-together: clause 1: startGroup with parallel true returns two accepted items with disjoint files and disjoint affected tests together [B3,C7]', () => {
  assert.deepEqual(startGroup([item(1, ['a.js'], ['a.test.js']), item(2, ['b.js'], ['b.test.js'])], { parallel: true }), [1, 2]);
});

test('landing.parallel-start.overlapping-items-never-share-a-group: clause 2: overlapping items are never in one start group [B3,C7]', () => {
  assert.deepEqual(startGroup([item(1, ['a.js'], ['x.test.js']), item(2, ['a.js'], ['y.test.js']), item(3, ['c.js'], ['c.test.js'])], { parallel: true }), [1, 3]);
  assert.deepEqual(startGroup([item(1, ['a.js'], ['x.test.js']), item(2, ['b.js'], ['x.test.js'])], { parallel: true }), [1]);
});

test('landing.parallel-start.parallel-off-starts-one: clause 3: with parallel false startGroup returns the first accepted item alone, as today [B3,C7]', () => {
  const accepted = [item(7, ['a.js'], []), item(8, ['b.js'], [])];
  assert.deepEqual(startGroup(accepted, { parallel: false }), [7]);
  assert.deepEqual(startGroup(accepted), [7]);
  assert.deepEqual(startGroup([], { parallel: true }), []);
});
