/** @pullboard-test-input packages/gate/src/io/run-tests.js packages/gate/src/io/run/tests.js */
/** Build, submit and review test runs split by the shard planner over the slots free after landings [C7]. */
/** @pullboard-world-pin: clause 1 reads packages/gate/src/io/run-tests.js (the engine apps/cli/src/io/run/tests.js launches) to prove the runner entry calls the ordinary-run shard helper. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ordinaryRunShards } from '../../../index.js';
import { planRunShards } from '../../../index.js';

const FILES = ['test/a.test.js', 'test/b.test.js', 'test/c.test.js', 'test/d.test.js'];
const TIMES = { 'test/a.test.js': 100, 'test/b.test.js': 10, 'test/c.test.js': 50, 'test/d.test.js': 50 };

test('clause 1: apps/cli/src/io/run/tests.js shards an ordinary run through the planner over the free runner slots [test] [C7]', () => {
  const plan = ordinaryRunShards({ files: FILES, freeSlots: 2, times: TIMES });
  assert.deepEqual(plan, planRunShards(FILES, 2, TIMES), 'an ordinary run takes the planner\'s split');
  assert.equal(plan.length, 2);
  assert.deepEqual(plan.flatMap(shard => shard.files).sort(), [...FILES].sort(), 'every selected file is in exactly one shard');
  const source = readFileSync(join(import.meta.dirname, '../../../../gate/src/io/run-tests.js'), 'utf8');
  assert.match(source, /ordinaryShards \? freeRunnerSlots\(\) : \(await import\('[^']+'\)\)\.landingShardCount/u, 'the runner entry sizes every non-landing, non-shard run by the free runner slots and runs it through the landing shard planner');
});

test('clause 2: landing stays first and a run takes only the slots free after landings [test] [C7]', () => {
  assert.equal(ordinaryRunShards({ files: FILES, freeSlots: 4, times: TIMES, landing: true }).length, 1, 'a landing keeps its own fan-out');
  assert.equal(ordinaryRunShards({ files: FILES, freeSlots: 4, times: TIMES, shard: true }).length, 1, 'a shard never splits again');
  assert.equal(ordinaryRunShards({ files: FILES, freeSlots: 4, times: TIMES, insideRunnerSlot: true }).length, 1, 'a run inside a runner slot never splits again');
  assert.equal(ordinaryRunShards({ files: FILES, freeSlots: 1, times: TIMES }).length, 1, 'no slot free after the landings leaves today\'s single pass');
  assert.deepEqual(ordinaryRunShards({ files: FILES, freeSlots: 0, times: TIMES })[0].files, FILES, 'same files in the same order');
  assert.equal(ordinaryRunShards({ files: FILES, freeSlots: 9, times: TIMES }).length, 4, 'never more shards than files');
});
