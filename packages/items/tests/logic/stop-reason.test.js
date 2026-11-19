/** Stop facts come from an item thread, never from an agent's words [C7,#11242]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stopFacts } from '../../src/logic/stop-reason.js';
import { stopReason } from '../../src/logic/stop-reason.js';

const move = (kind, detail = {}) => ({ type: 'move', kind, by: 'a', at: '2026-11-18T12:00:00Z', detail });
const NONE = { needsDecision: false, blockedBy: [], rejections: 0, refusals: 0 };

test('items.logic-stop-reason.facts-since-criterion-edit: clause 1: stopFacts counts reject and reopen as rejections and TOO_LARGE, INELIGIBLE, BLOCKED releases as refusals, only after the latest criterion edit [C7,#11242]', () => {
  const thread = [
    move('reject'), move('release', { reasonCode: 'INELIGIBLE' }),
    move('edit', { criterion: 'new' }),
    move('reject'), move('reopen'),
    move('release', { reasonCode: 'TOO_LARGE' }), move('release', { reasonCode: 'BLOCKED' }), move('release', { reasonCode: 'OTHER' }),
    move('edit', { title: 'only a title' }),
    { type: 'fact', kind: 'note', text: 'reject' },
  ];
  assert.deepEqual(stopFacts(thread), { needsDecision: false, blockedBy: [], rejections: 2, refusals: 2 });
  assert.deepEqual(stopFacts([move('reject'), move('edit', { criterion: 'x' })]), NONE);
  assert.deepEqual(stopFacts(undefined), NONE);
});

test('items.logic-stop-reason.reason-from-facts-only: clause 2: stopReason(stopFacts) is decision with an open decision, blocked with open dependencies, and thread text never changes it [C7,#11242]', () => {
  assert.equal(stopReason(stopFacts([], { openDecision: true })), 'decision');
  assert.equal(stopReason(stopFacts([], { openDependencies: [7] })), 'blocked');
  const quiet = [{ type: 'fact', kind: 'note', text: 'needs a decision, blocked on 7', detail: { reason: 'decision' } }];
  assert.equal(stopReason(stopFacts(quiet)), 'abandoned');
  assert.equal(stopReason(stopFacts([move('reject'), move('reject')])), 'wall');
  assert.equal(stopReason(stopFacts([move('reject')])), 'rework');
});
