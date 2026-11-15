/** A census shard's rows judge a file without a pass record by its own exit line, so voided case outcomes leave no file without a result [C7,#8304]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shardRows } from '../../src/logic/census.js';

const FILES = ['a/one.test.js', 'a/two.test.js', 'a/three.test.js'];
const shard = output => ({ files: FILES, status: 'red', host: 'h', label: '11/36', output, outcomes: [], times: {} });
const rows = output => Object.fromEntries(shardRows(shard(output), 'sha').map(row => [row.file, row]));
// A shard whose outcomes were voided by one cancelled case: totals, one named failure, and the shard's per-file exit lines.
const OUTPUT = [
  '# tests 166', '# pass 161', '# fail 2', '# cancelled 2',
  '# landing-file-ms 4100 a/one.test.js', '# landing-file-ms 9000 a/two.test.js',
  '# landing-file-exit 0 a/one.test.js', '# landing-file-exit 1 a/two.test.js',
].join('\n');

test('clause 1: a red shard\'s file with no failing case and no pass record gets a green row when its exit line reads 0 [C7]', () => {
  const row = rows(OUTPUT)['a/one.test.js'];
  assert.equal(row.status, 'green');
  assert.deepEqual(row.cases, []);
  assert.equal(row.secs, null, 'times come from the caller, as before');
});

test('clause 2: a red shard\'s file with no named failing case gets a red row when its exit line reads non-zero [C7]', () => {
  const row = rows(OUTPUT)['a/two.test.js'];
  assert.equal(row.status, 'red');
  assert.deepEqual(row.cases, ['its test process exited 1 with no failing case named']);
});

test('clause 3: a red shard\'s file with no exit line and no pass record still gets a no-result row [C7]', () => {
  assert.equal(rows(OUTPUT)['a/three.test.js'].status, 'no-result');
  assert.equal(rows('# tests 3\n# fail 1')['a/one.test.js'].status, 'no-result', 'a shard that printed no exit lines vouches for no file');
});
