/** The receipt cell judges a result in which every section is skip as red, never green [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge } from '../index.js';
import { SECTIONS } from '../index.js';

test('receipt.judge.all-skip: [C7] a result in which every section is skip judges red with a reason naming the all-skip', () => {
  const skipped = Object.fromEntries(SECTIONS.map((name) => [name, { outcome: 'skip' }]));
  const one = judge(skipped);
  assert.deepEqual([one.verdict, one.code], ['red', 'ALL_SKIP']);
  assert.equal(judge({ ...skipped, proof: { outcome: 'pass' } }).verdict, 'green', 'one real pass still judges green');
});
