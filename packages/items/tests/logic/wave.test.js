/** The wave picker names the largest set of ready items that touch no file in common [C7,#1440]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { largestDisjointWave } from '../../src/logic/wave.js';

const item = (id, files) => ({ item_id: id, item_files: files.join('\n'), item_brief: '' });

test('items.logic-wave.the-best-set-beats-first-fit: clause 1: largestDisjointWave returns the item ids of the largest set whose item_files share no path, for four overlapping candidates seeded so the greedy first-fit set is smaller than the best set [C7,#1440]', () => {
  const candidates = [item(1, ['x', 'y']), item(2, ['x']), item(3, ['y']), item(4, ['z'])];
  assert.deepEqual(largestDisjointWave(candidates), [2, 3, 4], 'first-fit would keep 1 and 4 only');
  assert.deepEqual(largestDisjointWave([]), [], 'no candidates, no wave');
});

test('items.logic-wave.the-same-input-gives-the-same-ids: clause 2: largestDisjointWave returns the same ids in the same order for the same input [C7,#1440]', () => {
  const candidates = [item(5, ['a']), item(6, ['a']), item(7, ['b']), item(8, ['b'])];
  const first = largestDisjointWave(candidates);
  assert.deepEqual(largestDisjointWave(candidates), first);
  assert.deepEqual(first, [5, 7], 'a tie keeps the earlier candidates');
});

test('items.logic-wave.a-candidate-with-no-files-is-always-in: clause 3: a candidate with no files is in every returned set [C7,#1440]', () => {
  const candidates = [item(9, ['q']), item(10, []), item(11, ['q'])];
  assert.deepEqual(largestDisjointWave(candidates), [9, 10]);
  assert.ok(largestDisjointWave([item(12, []), item(13, [])]).includes(12));
});
