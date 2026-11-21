/** costlyTests names the test files that failed gates for many unrelated items [C7,#12058]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costlyTests } from '../../../index.js';

const FILE = 'packages/gate/tests/flaky.test.js';
const row = (item, extra = {}) => ({ file: FILE, item, itemFiles: [], command: 'pullboard test', at: 1_000, ms: 120_000, ...extra });

test('stats.runners-costly-tests.lists-a-file-failing-for-five-items: clause 2: a file failing for 5 unrelated items is listed with its items, runs and runner-minutes [C7,#12058]', () => {
  const rows = [1, 2, 3, 4, 5].map(item => row(item));
  rows.push(row(5));
  assert.deepEqual(costlyTests(rows, { minItems: 5, since: 0 }), [{ file: FILE, items: [1, 2, 3, 4, 5], runs: 6, runnerMinutes: 12 }]);
  assert.deepEqual(costlyTests(rows.slice(0, 4), { minItems: 5, since: 0 }), []);
});

test('stats.runners-costly-tests.skips-items-that-name-the-file: clause 2: an item whose itemFiles names the test file is not counted [C7,#12058]', () => {
  const rows = [1, 2, 3, 4].map(item => row(item));
  rows.push(row(9, { itemFiles: [FILE] }));
  assert.deepEqual(costlyTests(rows, { minItems: 5, since: 0 }), []);
  assert.deepEqual(costlyTests(rows, { minItems: 4, since: 0 })[0].items, [1, 2, 3, 4]);
});

test('stats.runners-costly-tests.leaves-out-rows-before-since: clause 2: rows before since are left out [C7,#12058]', () => {
  const rows = [1, 2, 3].map(item => row(item, { at: 500 })).concat([4, 5].map(item => row(item, { at: 2_000 })));
  assert.deepEqual(costlyTests(rows, { minItems: 5, since: 0 }).map(entry => entry.items), [[1, 2, 3, 4, 5]]);
  assert.deepEqual(costlyTests(rows, { minItems: 5, since: 1_000 }), []);
  assert.deepEqual(costlyTests(rows, { minItems: 2, since: 1_000 }).map(entry => entry.items), [[4, 5]]);
});

test('stats.runners-costly-tests.counts-a-fileless-row-under-its-command: clause 2: a row with no file counts under its command [C7,#12058]', () => {
  const rows = [1, 2, 3, 4, 5].map(item => row(item, { file: null, command: 'npm test' }));
  assert.deepEqual(costlyTests(rows, { minItems: 5, since: 0 }).map(entry => entry.file), ['npm test']);
});
