/** The test file budget row writer: rows for files over 120 s, never raised (#3988, V22). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { ROW_THRESHOLD_MS } from '../../../src/io/test/budget-rows.js';
import { budgetRows } from '../../../src/io/test/budget-rows.js';
import { existingRows } from '../../../src/io/test/budget-rows.js';
import { writeBudgetRows } from '../../../src/io/test/budget-rows.js';
import { testFileBudgetPath } from '../../../src/io/test/file/policy.js';

test('gate.io-test-budget-rows.a-row-per-file-over-120: a row per file over 120 s, ms rounded up, none for faster files [V22]', () => {
  const rows = budgetRows({ 'a.test.js': 120_000, 'b.test.js': 120_000.4, 'c.test.js': 90_000, 'd.test.js': 418_000 });
  assert.deepEqual(rows, [{ file: 'b.test.js', ms: 120_001 }, { file: 'd.test.js', ms: 418_000 }]);
  assert.equal(ROW_THRESHOLD_MS, 120_000);
});

test('gate.io-test-budget-rows.re-running-never-raises-an-existing: re-running never raises an existing row, only lowers it [V22]', () => {
  const rows = budgetRows({ 'a.test.js': 300_000, 'b.test.js': 200_000 }, { 'a.test.js': 250_000, 'b.test.js': 400_000 });
  assert.deepEqual(rows, [{ file: 'a.test.js', ms: 250_000 }, { file: 'b.test.js', ms: 200_000 }]);
});

test('gate.io-test-budget-rows.rows-are-written-as-hashed-budget: rows are written as hashed budget files and read back [V22]', () => {
  const files = privateFixtureFiles('budget-rows-');
  files.write('apps/slow.test.js', '');
  const rows = [{ file: 'apps/slow.test.js', ms: 150_000 }, { file: 'apps/gone.test.js', ms: 150_000 }];
  assert.deepEqual(writeBudgetRows(files.root, rows), ['apps/slow.test.js']);
  assert.deepEqual(JSON.parse(readFileSync(join(files.root, testFileBudgetPath('apps/slow.test.js')), 'utf8')), { version: 1, file: 'apps/slow.test.js', ms: 150_000 });
  assert.deepEqual(existingRows(files.root), { 'apps/slow.test.js': 150_000 });
  assert.deepEqual(writeBudgetRows(files.root, rows), [], 'an unchanged row is not rewritten');
});
