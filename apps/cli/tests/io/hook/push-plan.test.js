/** The pre-push gate sizes its shards by recorded file time: each under a quarter of the job ceiling, heaviest first, unrecorded files at a default by kind, at most PUSH_MAX_SHARD_FILES each [C7,#7790,#8026]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PUSH_DEFAULT_FILE_MS } from '../../../src/io/hook/push.js';
import { PUSH_DEFAULT_JOURNEY_MS } from '../../../src/io/hook/push.js';
import { PUSH_MAX_SHARD_FILES } from '../../../src/io/hook/push.js';
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

test('clause 1: an unrecorded journey counts the journey estimate and an unrecorded unit test the file estimate, each above its measured mean wall [C7,#8026]', () => {
  const shards = planPushShards(['apps/cli/journeys/a/new.test.js', 'apps/relay/journeys/b.test.js', 'packages/gate/tests/new.test.js'], {}, 60 * 60_000);
  assert.equal(shards.reduce((total, shard) => total + shard.weight, 0), 2 * PUSH_DEFAULT_JOURNEY_MS + PUSH_DEFAULT_FILE_MS);
  assert.ok(PUSH_DEFAULT_JOURNEY_MS >= 2 * 29_500, 'a journey counts at least twice the 29.5 s census mean');
  assert.ok(PUSH_DEFAULT_FILE_MS >= 1.5 * 6_600 && PUSH_DEFAULT_FILE_MS < PUSH_DEFAULT_JOURNEY_MS, 'a unit test stays cheaper than a journey yet above its 6.6 s mean');
});

test('clause 1: on a main-sized gate with 144 recorded files, no shard estimates below its real run at the census mean walls or holds over the file cap [C7,#8026]', () => {
  const journeys = Array.from({ length: 1448 }, (_, at) => `apps/cli/journeys/j${at}.test.js`);
  const units = Array.from({ length: 829 }, (_, at) => `packages/gate/tests/u${at}.test.js`);
  const recorded = Array.from({ length: 144 }, (_, at) => `packages/store/tests/r${at}.test.js`);
  const times = Object.fromEntries(recorded.map((file, at) => [file, 47 + (at * 7919) % 30_000]));
  const budget = 40 * 60_000 / 4;
  const shards = planPushShards([...journeys, ...units, ...recorded], times, budget);
  const real = shard => shard.files.reduce((total, file) => total + (times[file] ?? (file.includes('/journeys/') ? 29_500 : 6_600)), 0);
  for (const shard of shards) {
    assert.ok(shard.weight >= real(shard), `a shard of ${shard.files.length} files estimates ${shard.weight} ms but runs ${real(shard)} ms`);
    assert.ok(shard.weight < budget, `a shard estimates ${shard.weight} ms, over the ${budget} ms budget`);
    assert.ok(shard.files.length <= PUSH_MAX_SHARD_FILES, `a shard holds ${shard.files.length} files`);
  }
  const most = Math.max(...shards.map(shard => shard.files.filter(file => file.includes('/journeys/')).length));
  assert.ok(most <= budget / PUSH_DEFAULT_JOURNEY_MS, `at most ten journeys per 10-minute shard, never the 119 of the overrun; got ${most}`);
});

test('clause 1: many cheap recorded files split at the file cap though their summed time fits one shard [C7,#8026]', () => {
  const files = Array.from({ length: 3 * PUSH_MAX_SHARD_FILES }, (_, at) => `packages/store/tests/t${at}.test.js`);
  const shards = planPushShards(files, Object.fromEntries(files.map(file => [file, 50])));
  assert.equal(shards.length, 3);
  for (const shard of shards) assert.equal(shard.files.length, PUSH_MAX_SHARD_FILES);
});
