/** Accepted items gate in parallel only when their files and affected tests are disjoint [B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parallelGatePlan } from '../../src/logic/parallel-plan.js';

const item = (id, files, tests) => ({ id, files, tests });

test('landing.parallel-plan.two-items-with-disjoint-changed-files: clause 1: two items with disjoint changed files and disjoint affected tests share one parallel group [B3,C7]', () => {
  assert.deepEqual(parallelGatePlan([item(1, ['a.js'], ['a.test.js']), item(2, ['b.js'], ['b.test.js'])]), [[1, 2]]);
});

test('landing.parallel-plan.items-whose-changed-files-or-affected: clause 2: items whose changed files or affected tests overlap are never in the same group [B3,C7]', () => {
  const byFile = parallelGatePlan([item(1, ['a.js'], ['a.test.js']), item(2, ['a.js'], ['b.test.js'])]);
  assert.deepEqual(byFile, [[1], [2]]);
  const byTest = parallelGatePlan([item(1, ['a.js'], ['x.test.js']), item(2, ['b.js'], ['x.test.js']), item(3, ['c.js'], ['c.test.js'])]);
  assert.deepEqual(byTest, [[1, 3], [2]]);
  assert.deepEqual(parallelGatePlan([]), []);
});

test('landing.parallel-plan.the-plan-is-deterministic-the-same: clause 3: the plan is deterministic, the same input giving the same groups in the same order [B3,C7]', () => {
  const input = [item(5, ['a.js'], []), item(3, ['a.js'], []), item(9, ['z.js'], ['z.test.js']), item(4, ['z.js'], [])];
  const first = parallelGatePlan(input);
  assert.deepEqual(first, [[5, 9], [3, 4]]);
  assert.deepEqual(parallelGatePlan(structuredClone(input)), first);
});
