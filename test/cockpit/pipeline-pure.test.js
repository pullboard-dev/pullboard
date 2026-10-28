/** Canonical lifecycle replay and pipeline projection from plain snapshot values [N26,N38,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MACHINE } from '../../src/machine.js';
import { replayItem } from '../../src/view/pipeline-model.js';
import { pipelineStage } from '../../src/view/pipeline-model.js';
import { pipelineSince } from '../../src/view/pipeline-model.js';
import { itemListFields } from '../../src/view/pipeline-model.js';

/** Make one recorded move with an explicit instant and actor. */
const event = (kind, minute, extra = {}) => ({ kind, at: new Date(Date.UTC(2026, 9, 28, 12, minute)).toISOString(), by: 'web-1', ...extra });

test('pipeline replay keeps retained corrections and renewals in Building, then enters review at submit [N26,N38,C7]', () => {
  const item = { status: 'submitted', history: [event('add', 0), event('claim', 1), event('refreeze', 2, { retainedClaim: true }), event('renew', 3), event('submit', 4), event('reserve', 5)] };
  const before = JSON.stringify(item), steps = replayItem(item, MACHINE);
  assert.deepEqual(steps.filter(step => step.move).map(step => [step.from, step.move.to]), [
    ['open', 'claimed'], ['claimed', 'claimed'], ['claimed', 'claimed'], ['claimed', 'submitted'], ['submitted', 'submitted'],
  ]);
  assert.equal(pipelineSince(item, MACHINE), event('submit', 4).at, 'review reservation does not restart the queue age');
  assert.equal(JSON.stringify(item), before);
});

test('pipeline arrival after a lapse uses the recorded claim deadline and a merge is later than acceptance [N26,N38,C7]', () => {
  const expiry = '2026-10-28T14:00:00Z';
  const expired = { status: 'open', updatedAt: event('edit', 5).at, history: [event('add', 0), event('claim', 1)],
    thread: [{ type: 'move', kind: 'claim', detail: { leaseUntil: expiry } }] };
  assert.equal(replayItem(expired, MACHINE).at(-1).move.verb, 'lapse');
  assert.equal(pipelineSince(expired, MACHINE), expiry);
  const merged = { status: 'verified', merged: 'a'.repeat(40), history: [event('accept', 3), event('merged', 4)], updatedAt: event('edit', 5).at };
  assert.equal(pipelineStage(merged), 'merged');
  assert.equal(pipelineSince(merged, MACHINE), event('merged', 4).at);
  assert.equal(pipelineStage({ status: 'verified' }), 'accepted');
});

test('list summaries remain authoritative while full snapshots derive holders and exact counts [N26,N38,C7]', () => {
  const summary = Object.freeze({ stage: 'submitted', since: event('submit', 4).at });
  assert.equal(itemListFields(summary, MACHINE), summary);
  const item = { status: 'submitted', reviewer: 'tests-1', reviewUntil: '2026-10-28T14:00:00Z', history: [event('add', 0), event('claim', 1), event('submit', 4)],
    verdicts: [{ decision: 'REJECT' }], thread: [{ type: 'fact' }, { type: 'move' }, { type: 'fact' }] };
  const before = JSON.stringify(item), fields = itemListFields(item, MACHINE);
  assert.deepEqual(fields.claim, { by: 'tests-1', until: item.reviewUntil });
  assert.deepEqual(fields.counts, { verdicts: 1, facts: 2 });
  assert.equal(fields.stage, 'submitted');
  assert.equal(fields.since, event('submit', 4).at);
  assert.equal(JSON.stringify(item), before);
});
