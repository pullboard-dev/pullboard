/** A test run's files split across the free runner slots by recorded times [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planFreeSlotShards } from '../index.js';

const TIMES = { 'test/a.test.js': 100_000, 'test/b.test.js': 60_000, 'test/c.test.js': 50_000, 'test/d.test.js': 40_000, 'test/e.test.js': 10_000 };
const FILES = Object.keys(TIMES);

test('landing.planner.a-test-run-splits-across-the: clause 1: a test run splits across the free runner slots it is given, balanced by recorded file times [C7]', () => {
  const plan = planFreeSlotShards(FILES, 3, TIMES);
  assert.equal(plan.slots, 3);
  assert.equal(plan.balance, 'history');
  assert.deepEqual(plan.shards.flatMap(shard => shard.files).sort(), [...FILES].sort(), 'every file runs exactly once');
  const weights = plan.shards.map(shard => shard.weight);
  assert.ok(Math.max(...weights) <= 100_000, `the heaviest shard is the slowest file alone, got ${weights}`);
  assert.ok(Math.max(...weights) - Math.min(...weights) <= 50_000);
  const one = planFreeSlotShards(FILES, 1, TIMES);
  assert.equal(one.slots, 1, 'one free slot runs as today');
  assert.deepEqual(one.shards[0].files, [...FILES].sort());
  assert.equal(planFreeSlotShards(FILES, 0, TIMES).slots, 1, 'no free slot still runs once');
  assert.equal(planFreeSlotShards(FILES, 40, TIMES).slots, 5, 'never more shards than files');
  assert.equal(planFreeSlotShards([...FILES, './test/a.test.js'], 2, TIMES).shards.flatMap(shard => shard.files).length, 5, 'a file spelled twice runs once');
  assert.equal(planFreeSlotShards(FILES, 2, {}).balance, 'file count');
});
