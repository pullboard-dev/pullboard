/** The pre-push gate sizes its shards by recorded file time: each under a quarter of the job ceiling, heaviest first, unrecorded files at a default [C7,#7790]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PUSH_DEFAULT_FILE_MS } from '../../../src/io/hook/push.js';
import { PUSH_SHARD_BUDGET_MS } from '../../../src/io/hook/push.js';
import { planPushShards } from '../../../src/io/hook/push.js';

/** The summed time of one shard's files, by the same rule the plan uses. */
const sum = (shard, times) => shard.files.reduce((total, file) => total + (times[file] ?? PUSH_DEFAULT_FILE_MS), 0);

test('clause 1: the budget is a quarter of the 20-minute job ceiling, and every shard of a 2,371-file gate sums under it [C7,#7790]', () => {
  assert.equal(PUSH_SHARD_BUDGET_MS, 5 * 60_000);
  const files = Array.from({ length: 2371 }, (_, at) => `t/f${at}.test.js`);
  const times = Object.fromEntries(files.filter((_, at) => at % 7).map((file, at) => [file, 500 + (at * 7919) % 40_000]));
  const shards = planPushShards(files, times);
  assert.ok(shards.length > 18, `finer than the 18 shards of dry run 7, got ${shards.length}`);
  for (const shard of shards) assert.ok(sum(shard, times) < PUSH_SHARD_BUDGET_MS, `shard of ${shard.files.length} files sums ${sum(shard, times)} ms`);
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), [...files].sort(), 'every file runs once');
});

test('clause 1: a file with no record counts the default estimate, a file over the budget gets a shard of its own, and the heaviest shard is first [C7,#7790]', () => {
  const files = ['a.test.js', 'b.test.js', 'huge.test.js', 'new1.test.js', 'new2.test.js'];
  const times = { 'a.test.js': 100_000, 'b.test.js': 100_000, 'huge.test.js': 9 * 60_000 };
  const shards = planPushShards(files, times);
  assert.deepEqual(shards[0].files, ['huge.test.js'], 'the heaviest file leads, alone, though over the budget');
  assert.equal(shards.length, 2);
  assert.equal(shards[1].weight, 200_000 + 2 * PUSH_DEFAULT_FILE_MS, 'the two new files count the default each');
  const tight = planPushShards(['a.test.js', 'b.test.js', 'c.test.js'], { 'a.test.js': 200_000, 'b.test.js': 200_000, 'c.test.js': 200_000 });
  assert.equal(tight.length, 3, 'two 200 s files would sum 400 s, over the 300 s budget, so each stands alone');
});

test('clause 1: a leading ./ reads the same record, a repeated file runs once, and two small files still make two shards [C7,#7790]', () => {
  const shards = planPushShards(['./a.test.js', './a.test.js', './b.test.js'], { 'a.test.js': 1_000 });
  assert.equal(shards.length, 2, 'never fewer than two shards for two files');
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), ['./a.test.js', './b.test.js']);
  assert.equal(shards.reduce((total, shard) => total + shard.weight, 0), 1_000 + PUSH_DEFAULT_FILE_MS);
});
