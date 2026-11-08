/** The shards of one run merge into one result and receipt, and a failing file in any shard fails the run naming it [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeRunShards, planRunShards } from '../packages/landing/index.js';

const FILES = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js'];
const ROWS = {
  'test/a.test.js': { file: 'test/a.test.js', pass: 3, fail: 0, skip: 1, exit: 0 },
  'test/b.test.js': { file: 'test/b.test.js', pass: 2, fail: 0, skip: 0, exit: 0 },
  'test/c.test.js': { file: 'test/c.test.js', pass: 5, fail: 0, skip: 0, exit: 0 },
  'test/d.test.js': { file: 'test/d.test.js', pass: 1, fail: 0, skip: 0, exit: 0 },
};
const report = shard => ({ files: shard.files.map(file => ROWS[file]) });

test('clause 1: shards of one run merge into one result and receipt identical in content to a single-slot run [test] [C7]', () => {
  const single = mergeRunShards(FILES, [report({ files: FILES })]);
  assert.equal(single.exit, 0);
  assert.deepEqual([single.pass, single.fail, single.skip], [11, 0, 1]);
  for (const slots of [2, 3, 4]) {
    const shards = planRunShards(FILES, slots, { 'test/a.test.js': 100, 'test/b.test.js': 10, 'test/c.test.js': 50 });
    assert.ok(shards.length > 1);
    assert.deepEqual(mergeRunShards(FILES, shards.map(report).reverse()), single, `${slots} slots merge to the single-slot receipt`);
  }
});

test('clause 2: a failing file in any shard fails the run with that file named, and a file no shard reported fails it too [test] [C7]', () => {
  const shards = planRunShards(FILES, 2, {});
  const red = shards.map(shard => ({ files: shard.files.map(file => file === 'test/c.test.js' ? { ...ROWS[file], pass: 4, fail: 1, exit: 1 } : ROWS[file]) }));
  const merged = mergeRunShards(FILES, red);
  assert.equal(merged.exit, 1);
  assert.deepEqual(merged.failing, ['test/c.test.js']);
  assert.equal(merged.fail, 1);
  const lost = mergeRunShards(FILES, [report(shards[0])]);
  assert.equal(lost.exit, 1);
  assert.deepEqual(lost.failing, shards[1].files.slice().sort((x, y) => FILES.indexOf(x) - FILES.indexOf(y)));
  const retried = mergeRunShards(FILES, [...red, report({ files: ['test/c.test.js'] })]);
  assert.deepEqual(retried.failing, ['test/c.test.js'], 'a green rerun does not hide a red');
});
