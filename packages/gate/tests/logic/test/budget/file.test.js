/** @pullboard-test-input packages/gate/src/logic/test/budget/file.js */
/** Test file tier limits as pure functions: cell 30 s, component 60 s, journey 120 s [C7,U148]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testFileBudgetFailure } from '../../../../src/logic/test/budget/file.js';
import { testFileTierBudget } from '../../../../src/logic/test/budget/file.js';
import { testFileTierLimit } from '../../../../src/logic/test/budget/file.js';

test('gate.logic-test-budget-file.tier-limits-are-30-60-120-seconds: clause 1: the tier limits are 30, 60 and 120 seconds, and an unknown tier throws naming it [C7,U148]', () => {
  assert.equal(testFileTierLimit('cell'), 30_000);
  assert.equal(testFileTierLimit('component'), 60_000);
  assert.equal(testFileTierLimit('journey'), 120_000);
  assert.throws(() => testFileTierLimit('suite'), error => error instanceof TypeError && error.message.includes('suite'));
  assert.throws(() => testFileTierLimit('toString'), TypeError);
});

test('gate.logic-test-budget-file.a-lower-row-wins-and-a-higher-one-is-refused: clause 2: a recorded row that is lower wins, none gives the tier limit, a higher row throws naming everything [C7,U148]', () => {
  assert.equal(testFileTierBudget('a.test.js', 'cell', undefined), 30_000);
  assert.equal(testFileTierBudget('a.test.js', 'cell', 12_000), 12_000);
  assert.equal(testFileTierBudget('a.test.js', 'journey', 120_000), 120_000);
  assert.throws(() => testFileTierBudget('a.test.js', 'cell', 45_000), error => error instanceof Error
    && ['a.test.js', 'cell', '45000', '30000'].every(part => error.message.includes(part)));
});

test('gate.logic-test-budget-file.a-cell-test-over-30-seconds-names-its-tier: clause 3: a cell test over 30 s names the cell tier and says to split it; with no tier the message is unchanged [C7,U148]', () => {
  const tiered = testFileBudgetFailure('a.test.js', 31_000, 30_000, false, 1, 'cell');
  assert.match(tiered, /^a\.test\.js took 31000ms, over its 30000ms cell tier test file budget; split it/u);
  assert.equal(testFileBudgetFailure('a.test.js', 31_000, 30_000),
    'a.test.js took 31000ms, over its 30000ms test file budget; split it or move it to the audit');
});
