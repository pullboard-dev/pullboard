/** A proof shard that connects after its admission window still has its full startup budget to reach READY [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startupDeadline } from '../../../src/io/dispatch.js';

test('runners.deadline.a-dispatch-connecting-after-its-admission: clause 1: a dispatch connecting after its admission window still has 90 s to reach READY [C7]', () => {
  // 9 Nov: shard transfers ran 31 s at p50; the shard budget is 90 s (packages/gate proof-shards SHARD_STARTUP_MS).
  const connect = 1_000_000;
  assert.equal(startupDeadline({ runnerWaitDeadline: connect - 5_000, runnerStartupMs: 90_000 }, connect), connect + 90_000,
    'a shard connecting after its admission window still has 90 s to reach READY');
});
