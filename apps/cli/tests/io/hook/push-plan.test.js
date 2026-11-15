/** The pre-push gate splits into at most eight partitions balanced by recorded file time, unrecorded files at a default by kind [C7,#7790,#8026,#8047]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PUSH_DEFAULT_FILE_MS } from '../../../src/io/hook/push.js';
import { PUSH_DEFAULT_JOURNEY_MS } from '../../../src/io/hook/push.js';
import { PUSH_MAX_SHARDS } from '../../../src/io/hook/push.js';
import { planPushShards } from '../../../src/io/hook/push.js';
import { pushPlanLimitMs } from '../../../src/io/hook/push.js';

/** A main-sized synthetic gate: 2,371 files, one in seven unrecorded, recorded times spread from 0.5 s to 40 s. */
function mainSized() {
  const files = Array.from({ length: 2371 }, (_, at) => `t/f${at}.test.js`);
  const times = Object.fromEntries(files.filter((_, at) => at % 7).map((file, at) => [file, 500 + (at * 7919) % 40_000]));
  return { files, times };
}

test('clause 1: a main-sized gate plans at most eight partitions, and every file lands in exactly one [C7,#8047]', () => {
  const { files, times } = mainSized();
  const shards = planPushShards(files, times);
  assert.equal(PUSH_MAX_SHARDS, 8);
  assert.equal(shards.length, 8);
  assert.deepEqual(shards.flatMap(shard => shard.files).sort(), [...files].sort(), 'every file runs once');
});

test('clause 1: partitions are balanced by recorded time, the heaviest within one largest file of the lightest [C7,#8047]', () => {
  const { files, times } = mainSized();
  const shards = planPushShards(files, times);
  const weights = shards.map(shard => shard.weight);
  assert.ok(Math.max(...weights) - Math.min(...weights) <= Math.max(PUSH_DEFAULT_FILE_MS, ...Object.values(times)), `spread ${weights}`);
  assert.deepEqual([...weights].sort((a, b) => b - a), weights, 'heaviest partition first');
});

test('clause 1: a file with no record counts the default estimate, and each recorded file counts its own time [C7,#8047]', () => {
  const shards = planPushShards(['a.test.js', 'b.test.js', 'huge.test.js', 'new1.test.js', 'new2.test.js'], { 'a.test.js': 100_000, 'b.test.js': 100_000, 'huge.test.js': 540_000 }, 2);
  assert.deepEqual(shards[0].files, ['huge.test.js'], 'the heaviest file leads, alone against the rest');
  assert.equal(shards[1].weight, 200_000 + 2 * PUSH_DEFAULT_FILE_MS);
});

test('clause 1: fewer files than partitions make one each, two files make two, and a leading ./ reads the same record [C7,#8047]', () => {
  const few = planPushShards(['./a.test.js', './a.test.js', './b.test.js'], { 'a.test.js': 1_000 });
  assert.equal(few.length, 2, 'a repeated file runs once');
  assert.equal(few.reduce((total, shard) => total + shard.weight, 0), 1_000 + PUSH_DEFAULT_FILE_MS);
  assert.deepEqual(planPushShards([], {}), []);
});

test('clause 1: an unrecorded journey counts the journey estimate and an unrecorded unit test the file estimate [C7,#8026]', () => {
  const shards = planPushShards(['apps/cli/journeys/a/new.test.js', 'apps/relay/journeys/b.test.js', 'packages/gate/tests/new.test.js'], {});
  assert.equal(shards.reduce((total, shard) => total + shard.weight, 0), 2 * PUSH_DEFAULT_JOURNEY_MS + PUSH_DEFAULT_FILE_MS);
  assert.ok(PUSH_DEFAULT_FILE_MS < PUSH_DEFAULT_JOURNEY_MS);
});

test('clause 1: the wait limit is the pushGate.shardMinutes setting, or the heaviest partition when that is longer [C7,#8047]', () => {
  const config = { pushGate: { shardMinutes: 20 } };
  assert.equal(pushPlanLimitMs([{ weight: 5 * 60_000 }], config, {}), 20 * 60_000, 'a light plan keeps the setting');
  assert.equal(pushPlanLimitMs([{ weight: 90 * 60_000 }, { weight: 80 * 60_000 }], config, {}), 90 * 60_000, 'a heavy plan is never given up on early');
});
