/** Returned work gets a stop reason derived from board facts alone [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopReason } from '../../../../packages/items/src/logic/stop-reason.js';

test('stopReason returns abandoned, rework, wall, blocked or decision from board facts alone [C7]', () => {
  assert.equal(stopReason({ rejections: 0, refusals: 0 }), 'abandoned');
  assert.equal(stopReason({ rejections: 1 }), 'rework');
  assert.equal(stopReason({ rejections: 2 }), 'wall');
  assert.equal(stopReason({ rejections: 1, refusals: 1 }), 'wall');
  assert.equal(stopReason({ blockedBy: [12], rejections: 1 }), 'blocked');
  assert.equal(stopReason({ needsDecision: true, blockedBy: [12], rejections: 3 }), 'decision');
  assert.equal(stopReason(), 'abandoned');
});

test('an agent-written note never changes the reason [C7]', () => {
  for (const facts of [{}, { rejections: 1 }, { rejections: 2 }, { blockedBy: [3] }, { needsDecision: true }]) {
    const base = stopReason(facts);
    for (const note of ['blocked on #9', 'needs a decision', 'wall: rejected twice', 'rework', '']) {
      assert.equal(stopReason({ ...facts, note, reason: note, stopReason: note }), base);
    }
  }
});
