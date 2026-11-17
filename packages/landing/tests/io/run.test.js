/** The run shard planner splits selected test files across free runner slots by recorded time [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRunShards } from '../../index.js';

test('landing.run.a-run-shard-planner-on-top: clause 1: a run shard planner on top of landing-shards splits N selected test files across the free runner slots balanced by recorded per-file times [C7]', () => {
  const files = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js'];
  const times = { 'test/a.test.js': 100, 'test/b.test.js': 10, 'test/c.test.js': 50, 'test/d.test.js': 50 };
  const plan = planRunShards(files, 2, times);
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.map(shard => shard.weight).sort((x, y) => x - y), [100, 110]);
  assert.deepEqual(plan.flatMap(shard => shard.files).sort(), [...files].sort());
  assert.equal(planRunShards(files, 9, times).length, 4, 'never more shards than files');
  assert.equal(planRunShards(files, 3, {}).length, 3, 'file count balances when no time is recorded');
});

test('landing.run.with-one-free-slot-the-planner: clause 2: with one free slot the planner returns a single shard identical to today\'s run [C7]', () => {
  const files = ['test/z.test.js', 'test/a.test.js', 'test/m.test.js'];
  for (const slots of [1, 0, -2, undefined]) {
    const plan = planRunShards(files, slots, { 'test/z.test.js': 5 });
    assert.equal(plan.length, 1);
    assert.deepEqual(plan[0].files, files, 'same files in the same order');
  }
});
