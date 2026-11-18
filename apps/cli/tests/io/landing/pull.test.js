/** landingOfferBatches cuts one offer's free items into jobs: sliced by size as before, or one job per item of the first parallel start group [C7,#9836]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingOfferBatches } from '../../../src/io/landing/pull.js';

/** Accepted entries in accept order: #1 and #2 are disjoint, #3 shares #1's file, #4 shares #2's test. */
const free = [
  { id: 1, files: ['a.js', 'a.test.js'], tests: ['a.test.js'] },
  { id: 2, files: ['b.js', 'b.test.js'], tests: ['b.test.js'] },
  { id: 3, files: ['a.js'], tests: [] },
  { id: 4, files: ['d.js'], tests: ['b.test.js'] },
];

test('cli.io-landing-pull.parallel-on-offers-group: clause 1: with parallel on, one single-item batch per id of the first start group, so disjoint items are offered together and items sharing a file or test are not [C7,#9836]', () => {
  const batches = landingOfferBatches(free, { size: 4, parallel: true });
  assert.deepEqual(batches.map(batch => batch.map(entry => entry.id)), [[1], [2]]);
  assert.equal(batches[0][0], free[0], 'the entry itself is offered');
  assert.deepEqual(landingOfferBatches([free[0], free[2]], { size: 4, parallel: true }).map(batch => batch[0].id), [1], 'a shared file keeps #3 out');
  assert.deepEqual(landingOfferBatches([free[1], free[3]], { size: 4, parallel: true }).map(batch => batch[0].id), [2], 'a shared test keeps #4 out');
  assert.deepEqual(landingOfferBatches([], { size: 4, parallel: true }), []);
});

test('cli.io-landing-pull.parallel-off-as-today: clause 2: with parallel off, free is cut into batches of size exactly as the slice loop on main does [C7,#9836]', () => {
  assert.deepEqual(landingOfferBatches(free, { size: 3 }).map(batch => batch.map(entry => entry.id)), [[1, 2, 3], [4]]);
  assert.deepEqual(landingOfferBatches(free, { size: 1, parallel: false }).map(batch => batch.map(entry => entry.id)), [[1], [2], [3], [4]]);
  assert.deepEqual(landingOfferBatches(free, { size: 4, parallel: false }).map(batch => batch.length), [4]);
  assert.deepEqual(landingOfferBatches([], { size: 2 }), []);
});
