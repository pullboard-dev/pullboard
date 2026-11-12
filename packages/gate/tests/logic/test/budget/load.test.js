/** File time limits charge each file for its own work: wall time divided by the runner's measured load per core [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_LOAD_SCALE } from '../../../../src/logic/test/budget/file.js';
import { testFileBudgetFailure } from '../../../../src/logic/test/budget/file.js';
import { testFileLoadScale } from '../../../../src/logic/test/budget/file.js';

test('clause 1: the load scale is the mean load per core, never under 1 and never over the ceiling [C7]', () => {
  assert.equal(testFileLoadScale([5, 7], 10), 1, 'a runner with spare cores charges wall time as is');
  assert.equal(testFileLoadScale([14, 16], 10), 1.5);
  assert.equal(testFileLoadScale([90], 10), MAX_LOAD_SCALE, 'a hung file still fails on the busiest runner');
  assert.equal(testFileLoadScale([], 10), 1);
  assert.equal(testFileLoadScale([Number.NaN], 10), 1, 'an unreadable load charges wall time');
});

test('clause 1: a file over its wall budget only because the runner was loaded passes; one over its share still fails [C7]', () => {
  assert.equal(testFileBudgetFailure('a.test.js', 168_000, 120_000, false, 1.5), null, '#6360: 168 s at 1.5x load is 112 s of its own');
  assert.match(testFileBudgetFailure('a.test.js', 168_000, 120_000, false, 1.2),
    /^a\.test\.js took 168000ms \(140000ms at runner load 1\.2x\), over its 120000ms test file budget/u);
  assert.match(testFileBudgetFailure('a.test.js', 600_000, 120_000, false, 10), /150000ms at runner load 4\.0x/u);
  assert.match(testFileBudgetFailure('a.test.js', 121_000, 120_000), /^a\.test\.js took 121000ms, over/u, 'an idle runner keeps the old message');
});
