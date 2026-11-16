/** @pullboard-test-input source-cell apps/cli */
/** The push gate's shard target time tunes itself from the last pushes' recorded shard times, by a quarter per step and only with pushGate.sizeFromBoard on [C7,U151,#9372]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PUSH_MAX_SHARDS } from '../../src/io/hook/push.js';
import { pushMaxShards } from '../../src/io/hook/push.js';
import { tunedTargetMs } from '../../src/logic/push-tune.js';

const MIN = 60_000;
const TARGET = 5 * MIN;
/** A recorded push whose shards took these times, on day `n` of the month. */
const push = (n, ...times) => ({ at: `2026-11-${String(n).padStart(2, '0')}T10:00:00.000Z`, parts: times.map(wallMs => ({ files: 1, runner: 'r', wallMs })) });

test('clause 1: tunedTargetMs returns the default when fewer than 3 pushes are recorded [C7,U151,#9372]', () => {
  assert.equal(tunedTargetMs([], TARGET), TARGET);
  assert.equal(tunedTargetMs([push(1, 9 * MIN), push(2, 9 * MIN)], TARGET), TARGET);
  assert.equal(tunedTargetMs(undefined, TARGET), TARGET);
});

test('clause 1: tunedTargetMs lowers the target by a quarter when the slowest shard ran over 1.5 times it in each of the last 3 pushes [C7,U151,#9372]', () => {
  assert.equal(tunedTargetMs([push(1, 8 * MIN), push(2, 8 * MIN, MIN), push(3, 7.6 * MIN)], TARGET), TARGET * 0.75);
  assert.equal(tunedTargetMs([push(1, 8 * MIN), push(2, 4 * MIN), push(3, 8 * MIN)], TARGET), TARGET, 'one push under 1.5 times keeps the target');
  assert.equal(tunedTargetMs([push(1, 1), push(2, 8 * MIN), push(3, 8 * MIN), push(4, 8 * MIN)], TARGET), TARGET * 0.75, 'only the newest 3 count, however the rows are ordered');
});

test('clause 1: tunedTargetMs raises the target by a quarter when every shard stayed under half of it in each of the last 3 pushes [C7,U151,#9372]', () => {
  assert.equal(tunedTargetMs([push(1, 2 * MIN, MIN), push(2, MIN), push(3, 2.4 * MIN)], TARGET), TARGET * 1.25);
  assert.equal(tunedTargetMs([push(1, MIN), push(2, 2.6 * MIN), push(3, MIN)], TARGET), TARGET, 'a shard at half the target or more keeps it');
});

test('clause 1: tunedTargetMs never leaves 2 to 20 minutes and ignores rows with no shard time [C7,U151,#9372]', () => {
  assert.equal(tunedTargetMs([push(1, 99 * MIN), push(2, 99 * MIN), push(3, 99 * MIN)], 2 * MIN), 2 * MIN);
  assert.equal(tunedTargetMs([push(1, MIN), push(2, MIN), push(3, MIN)], 20 * MIN), 20 * MIN);
  assert.equal(tunedTargetMs([], 30 * MIN), 20 * MIN);
  assert.equal(tunedTargetMs([push(1), { at: '2026-11-02T10:00:00.000Z' }, push(3, 8 * MIN), push(4, 8 * MIN)], TARGET), TARGET, 'rows without shard times do not count toward the 3');
});

test('clause 2: pushMaxShards uses the tuned target only with pushGate.sizeFromBoard on, and gives the unchanged output with it off [C7,U151,#9372]', () => {
  const files = ['a.test.js', 'b.test.js'];
  const times = { 'a.test.js': 10 * MIN, 'b.test.js': 10 * MIN };
  const slow = [push(1, 8 * MIN), push(2, 8 * MIN), push(3, 8 * MIN)];
  const on = { pushGate: { sizeFromBoard: true, shardMinutes: 20 } };
  assert.equal(pushMaxShards(files, times, on, 8, []), 4, '20 min of files over the 5 min default target');
  assert.equal(pushMaxShards(files, times, on, 8, slow), 6, 'slow shards cut the target to 3.75 min, so more shards');
  assert.equal(pushMaxShards(files, times, { pushGate: { shardMinutes: 20 } }, 8, slow), PUSH_MAX_SHARDS, 'off, the fixed plan stands whatever the history says');
  assert.equal(pushMaxShards(files, times, { pushGate: { sizeFromBoard: false } }, 8, slow), pushMaxShards(files, times, { pushGate: { sizeFromBoard: false } }, 8), 'off, history changes nothing');
});
