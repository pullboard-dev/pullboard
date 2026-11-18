/**
 * The moved-main fixture's quiet window: when a silent worker counts as dead [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { quietWindow } from '../../fixtures/main/moved.js';

const GAP = { live: false, rowsSignature: '[]' };

test('cli.logic-main-moved-quiet.a-worker-whose-wake-file-lands-late: a worker whose wake file lands late, with its owner file just after, is not judged dead [C7]', () => {
  const quiet = quietWindow(0);
  quiet.trigger(0);
  // Sixty seconds of slow start with no wake file: still inside the start grace.
  assert.equal(quiet.expired({ ...GAP, at: 60000, wakeGeneration: 0, expectedGeneration: 1 }), false);
  // wake.json appears; a poll in the gap before owner.json must not inherit the 60 s of waiting.
  assert.equal(quiet.expired({ ...GAP, at: 60010, wakeGeneration: 1, expectedGeneration: 1 }), false);
  assert.equal(quiet.expired({ ...GAP, at: 60035, wakeGeneration: 1, expectedGeneration: 1 }), false);
  // A worker that stays silent for the quiet window after waking is still caught.
  assert.equal(quiet.expired({ ...GAP, at: 68011, wakeGeneration: 1, expectedGeneration: 1 }), true);
});

test('cli.logic-main-moved-quiet.a-second-trigger-of-a-slow-starting: a second trigger of a slow-starting worker gets the same start grace as the first [C7]', () => {
  const quiet = quietWindow(0);
  quiet.trigger(0);
  assert.equal(quiet.expired({ ...GAP, at: 100, wakeGeneration: 1, expectedGeneration: 1 }), false);
  // The first wake file is still on disk (generation 1) when the second trigger expects generation 2.
  quiet.trigger(20000);
  assert.equal(quiet.expired({ ...GAP, at: 50000, wakeGeneration: 1, expectedGeneration: 2 }), false);
  assert.equal(quiet.expired({ ...GAP, at: 109000, wakeGeneration: 1, expectedGeneration: 2 }), false);
  assert.equal(quiet.expired({ ...GAP, at: 110001, wakeGeneration: 1, expectedGeneration: 2 }), true);
  // A live owner is never dead, however quiet.
  assert.equal(quiet.expired({ ...GAP, live: true, at: 999999, wakeGeneration: 1, expectedGeneration: 2 }), false);
});
