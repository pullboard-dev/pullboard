/** A pulled census shard's receipt tail is clipped, so each green file's time comes from the runner's whole-output record [C7,#8576]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pulledTimeLines } from '../../src/logic/census.js';
import { shardRows } from '../../src/logic/census.js';

const PREFIX = '# landing-file-ms ';
const FILES = ['a/one.test.js', 'a/two.test.js', 'a/three.test.js'];
// The clipped tail: no time lines and no totals, only the outcome frames' file results.
const TAIL = 'run-tests: phases selection 1.0s, tests 30.0s, total 31.0s\n';
const outcomes = FILES.map(file => ({ file, name: 'case', passed: true, skipped: false }));
// Read the lines back as the census does: `<prefix><ms> <file>`.
const parse = text => Object.fromEntries(text.split('\n').filter(line => line.startsWith(PREFIX)).map((line) => { const [ms, file] = line.slice(PREFIX.length).split(' '); return [file, Number(ms)]; }));

test('cli.logic-census-times.a-census-over-a-batch-of-three: clause 1: a census over a batch of three green files records a positive secs for each file though the clipped tail holds no time line [C7]', () => {
  const lines = pulledTimeLines({ 'a/one.test.js': 4100.4, 'a/two.test.js': 9000, 'a/three.test.js': 350 }, PREFIX);
  const rows = shardRows({ files: FILES, status: 'green', host: 'h', label: '1/1', output: lines + TAIL, outcomes, times: parse(lines + TAIL) }, 'sha');
  assert.deepEqual(rows.map(row => row.status), ['green', 'green', 'green']);
  assert.deepEqual(rows.map(row => row.secs), [4.1, 9, 0.4]);
  assert.ok(rows.every(row => row.secs > 0));
});

test('cli.logic-census-times.a-shard-that-sent-no-times-gives: clause 1: a shard that sent no times gives no secs, never a made-up one [C7]', () => {
  assert.equal(pulledTimeLines(undefined, PREFIX), '');
  assert.equal(pulledTimeLines(null, PREFIX), '');
});

test('cli.logic-census-times.overlapping-files-in-a-shard-never-sum: clause 2: overlapping files in a shard never sum past the shard tests phase, so overlap is not counted twice [C7,#8890]', () => {
  // Three files ran side by side: 20 s, 20 s and 20 s of wall each inside a 30 s tests phase.
  const times = { 'a/one.test.js': 20000, 'a/two.test.js': 20000, 'a/three.test.js': 20000 };
  const rows = shardRows({ files: FILES, status: 'green', host: 'h', label: '1/1', output: TAIL, outcomes, times }, 'sha');
  const sum = rows.reduce((total, row) => total + row.secs, 0);
  assert.ok(sum <= 30 && sum > 29, `sum ${sum}`);
  assert.deepEqual(rows.map(row => row.secs), [10, 10, 10]);
});
