/** planQueue chains accepted arrivals into candidates, each on the one before it, at most four deep [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planBatches } from '../../src/logic/queue.js';
import { planQueue } from '../../src/logic/queue.js';

test('landing.queue.three-batches-chain-on-main-then: clause 1: three batches chain on main, then on each candidate before them, each carrying the items below it [C7]', () => {
  const { candidates, waiting } = planBatches([[1], [2], [3]]);
  assert.deepEqual(candidates.map(c => [c.id, c.parent, c.items, c.below]), [
    ['candidate-1', null, [1], []],
    ['candidate-2', 'candidate-1', [2], [1]],
    ['candidate-3', 'candidate-2', [3], [1, 2]],
  ]);
  assert.deepEqual(waiting, []);
});

test('landing.queue.every-arrival-since-the-last-candidate: clause 1: every arrival since the last candidate joins one batch, and past four candidates arrivals wait [C7]', () => {
  assert.deepEqual(planQueue({ arrivals: [4, 5, 4] }).candidates[0].items, [4, 5]);
  const full = planBatches([[1], [2], [3], [4], [5, 6]]);
  assert.equal(full.candidates.length, 4);
  assert.deepEqual(full.waiting, [5, 6]);
  assert.deepEqual(planQueue({ arrivals: [1, 7], inFlight: full.candidates.slice(0, 1) }).candidates[0].items, [7], 'an item already in flight is not planned twice');
});
