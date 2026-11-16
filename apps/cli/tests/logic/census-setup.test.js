/** A census row carries setupSecs: the file's wall seconds minus the sum of its top-level cases' duration_ms, read from TAP [C7,#9028]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FILE_CASE_LINE } from '../../src/logic/census.js';
import { shardRows } from '../../src/logic/census.js';
import { tapCaseMs } from '../../src/logic/census.js';

const FILES = ['a/one.test.js', 'a/two.test.js'];
const outcomes = [
  { file: 'a/one.test.js', name: 'one parses', passed: true, skipped: false },
  { file: 'a/one.test.js', name: 'one writes', passed: true, skipped: false },
  { file: 'a/two.test.js', name: 'two parses', passed: true, skipped: false },
];
// Two top-level cases for one.test.js (500 + 1500 ms) with a nested case that is not top level, and one for two.test.js.
const TAP = `TAP version 13
# Subtest: one parses
ok 1 - one parses
  ---
  duration_ms: 500.5
  ...
# Subtest: one writes
    # Subtest: nested
    ok 1 - nested
      ---
      duration_ms: 9000
      ...
ok 2 - one writes
  ---
  duration_ms: 1499.5
  ...
ok 3 - two parses
  ---
  duration_ms: 250
  ...
run-tests: phases selection 1.0s, tests 60.0s, total 61.0s
`;
const times = { 'a/one.test.js': 12000, 'a/two.test.js': 3000 };

test('clause 1: shardRows gives setupSecs as the file wall seconds minus the sum of its top-level test duration_ms read from TAP [C7,#9028]', () => {
  assert.deepEqual(tapCaseMs(TAP, outcomes), { 'a/one.test.js': 2000, 'a/two.test.js': 250 });
  const rows = shardRows({ files: FILES, status: 'green', host: 'h', label: '1/1', output: TAP, outcomes, times }, 'sha');
  assert.deepEqual(rows.map(row => row.setupSecs), [10, 2.8]);
  assert.deepEqual(rows.map(row => row.secs), [12, 3]);
});

test('clause 1: a pulled shard whose tail lost its TAP takes each file case time from the runner record lines, and a file with none reads null [C7,#9028]', () => {
  const output = `${FILE_CASE_LINE}2000 a/one.test.js\nrun-tests: phases selection 1.0s, tests 60.0s, total 61.0s\n`;
  const rows = shardRows({ files: FILES, status: 'green', host: 'h', label: '1/1', output, outcomes, times }, 'sha');
  assert.deepEqual(rows.map(row => row.setupSecs), [10, null]);
});

test('clause 1: setup scales with the wall time when overlapping files are scaled to the shard tests phase, and is never negative [C7,#9028]', () => {
  const output = `${FILE_CASE_LINE}50000 a/two.test.js\nrun-tests: phases selection 1.0s, tests 7.5s, total 8.5s\n`;
  const rows = shardRows({ files: FILES, status: 'green', host: 'h', label: '1/1', output, outcomes, times }, 'sha');
  assert.deepEqual(rows.map(row => row.secs), [6, 1.5]);
  assert.equal(rows[1].setupSecs, 0);
});
