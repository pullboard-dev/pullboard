/** A census shard's rows read each file's own pass record, even when its clipped log lost the TAP totals [C7,#8293]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shardRows } from '../../src/logic/census.js';

const FILES = ['a/one.test.js', 'a/two.test.js', 'a/three.test.js'];
const shard = (output, outcomes) => ({ files: FILES, status: 'red', host: 'h', label: '2/36', output, outcomes, times: {} });
const verdicts = rows => Object.fromEntries(rows.map(row => [row.file, row.status]));
// The receipt's clipped tail: outcome frames and the phase line, with the `# tests N` totals cut off the front.
const TAIL = '# pullboard test outcomes {}\nrun-tests: phases selection 17.5s, tests 287.4s, total 307.5s\n';

test('clause 1: a red shard whose outcomes record a file passing gives it a green row though its output has no TAP totals line [C7]', () => {
  const outcomes = [
    { file: 'a/one.test.js', name: 'x', passed: true, skipped: false },
    { file: 'a/one.test.js', name: 'y', passed: true, skipped: false },
    { file: 'a/two.test.js', name: 'z', passed: false, skipped: false },
  ];
  assert.deepEqual(verdicts(shardRows(shard(TAIL, outcomes), 'sha')), { 'a/one.test.js': 'green', 'a/two.test.js': 'red', 'a/three.test.js': 'no-result' });
});

test('clause 2: a red shard with neither TAP totals nor any pass record gives each file without a failing case a no-result row [C7]', () => {
  const outcomes = [{ file: 'a/two.test.js', name: 'z', passed: false, skipped: false }];
  assert.deepEqual(verdicts(shardRows(shard('Error: Cannot find module node\n', outcomes), 'sha')), { 'a/one.test.js': 'no-result', 'a/two.test.js': 'red', 'a/three.test.js': 'no-result' });
});
