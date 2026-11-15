/** Canonical lifecycle replay and pipeline projection from plain snapshot values [N26,N38,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lifecycleMove } from '../../../../../packages/items/browser.js';
import { replayItem } from '../../../src/logic/pipeline/model.js';
import { pipelineStage } from '../../../src/logic/pipeline/model.js';
import { pipelineSince } from '../../../src/logic/pipeline/model.js';
import { itemListFields } from '../../../src/logic/pipeline/model.js';
import { withdrawnFromStatus } from '../../../src/logic/pipeline/model.js';
import { itemStagePresentation } from '../../../src/logic/pipeline/model.js';
import { itemStageKey } from '../../../src/logic/pipeline/model.js';
import { stageSentence } from '../../../src/logic/pipeline/model.js';

// Explicit lifecycle data, rather than importing engine discovery and its filesystem adapter.
const FLOW = { initial: 'open', moves: [
  ['claim', 'open', 'claimed', 'agent'], ['claim', 'claimed', 'claimed', 'agent'],
  ['refreeze', 'claimed', 'claimed', 'agent'], ['refreeze', 'claimed', 'open', 'agent'],
  ['submit', 'claimed', 'submitted', 'agent'], ['reserve', 'submitted', 'submitted', 'agent'],
  ['lapse', 'claimed', 'open', 'clock'],
].map(([verb, from, to, by]) => ({ verb, from: [from], to, by: [by] })) };

/** Make one recorded move with an explicit instant and actor. */
const event = (kind, minute, extra = {}) => ({ kind, at: new Date(Date.UTC(2026, 9, 28, 12, minute)).toISOString(), by: 'web-1', ...extra });

test('pipeline replay keeps retained corrections and renewals in Building, then enters review at submit [N26,N38,C7]', () => {
  const item = { status: 'submitted', history: [event('add', 0), event('claim', 1), event('refreeze', 2, { retainedClaim: true }), event('renew', 3), event('submit', 4), event('reserve', 5)] };
  const before = JSON.stringify(item), steps = replayItem(item, FLOW, lifecycleMove);
  assert.deepEqual(steps.filter(step => step.move).map(step => [step.from, step.move.to]), [
    ['open', 'claimed'], ['claimed', 'claimed'], ['claimed', 'claimed'], ['claimed', 'submitted'], ['submitted', 'submitted'],
  ]);
  assert.equal(pipelineSince(item, FLOW, lifecycleMove), event('submit', 4).at, 'review reservation does not restart the queue age');
  assert.equal(JSON.stringify(item), before);
});

test('pipeline arrival after a lapse uses the recorded claim deadline and a merge is later than acceptance [N26,N38,C7]', () => {
  const expiry = '2026-10-28T14:00:00Z';
  const expired = { status: 'open', updatedAt: event('edit', 5).at, history: [event('add', 0), event('claim', 1)],
    thread: [{ type: 'move', kind: 'claim', detail: { leaseUntil: expiry } }] };
  assert.equal(replayItem(expired, FLOW, lifecycleMove).at(-1).move.verb, 'lapse');
  assert.equal(pipelineSince(expired, FLOW, lifecycleMove), expiry);
  const merged = { status: 'verified', merged: 'a'.repeat(40), history: [event('accept', 3), event('merged', 4)], updatedAt: event('edit', 5).at };
  assert.equal(pipelineStage(merged), 'merged');
  assert.equal(pipelineSince(merged, FLOW, lifecycleMove), event('merged', 4).at);
  assert.equal(pipelineStage({ status: 'verified' }), 'accepted');
});

test('list summaries remain authoritative while full snapshots derive holders and exact counts [N26,N38,C7]', () => {
  const summary = Object.freeze({ stage: 'submitted', since: event('submit', 4).at });
  assert.equal(itemListFields(summary, FLOW, { match: lifecycleMove }), summary);
  const item = { status: 'submitted', reviewer: 'tests-1', reviewUntil: '2026-10-28T14:00:00Z', history: [event('add', 0), event('claim', 1), event('submit', 4)],
    verdicts: [{ decision: 'REJECT' }], thread: [{ type: 'fact' }, { type: 'move' }, { type: 'fact' }] };
  const before = JSON.stringify(item), fields = itemListFields(item, FLOW, { match: lifecycleMove });
  assert.deepEqual(fields.claim, { by: 'tests-1', until: item.reviewUntil });
  assert.deepEqual(fields.counts, { verdicts: 1, facts: 2 });
  assert.equal(fields.stage, 'submitted');
  assert.equal(fields.since, event('submit', 4).at);
  assert.equal(JSON.stringify(item), before);
});

/** Verify withdrawal recovery for each lifecycle transition represented in stored history. */
function testWithdrawnStageRecovery() {
  assert.equal(withdrawnFromStatus({ status: 'withdrawn', history: [] }), 'open');
  assert.equal(withdrawnFromStatus({ status: 'withdrawn', withdrawnFrom: 'verified', history: [] }), 'verified');
  assert.equal(withdrawnFromStatus({ status: 'withdrawn', history: [event('claim', 1), event('withdraw', 2)] }), 'claimed');
  assert.equal(withdrawnFromStatus({ status: 'withdrawn', history: [event('renew', 1), event('withdraw', 2)] }), 'claimed');
  for (const kind of ['submit', 'submit-merge', 'intake']) {
    assert.equal(withdrawnFromStatus({ status: 'withdrawn', history: [event(kind, 1), event('withdraw', 2)] }), 'submitted');
  }
  assert.equal(withdrawnFromStatus({ status: 'withdrawn', history: [event('accept', 1), event('withdraw', 2)] }), 'verified');
  assert.equal(withdrawnFromStatus({ status: 'withdrawn', history: [event('merged', 1), event('withdraw', 2)] }), 'merged');
  for (const kind of ['add', 'reject', 'reopen', 'release', 'lapse']) {
    assert.equal(withdrawnFromStatus({ status: 'withdrawn', history: [event('claim', 1), event(kind, 2), event('withdraw', 3)] }), 'open');
  }
}

/** Verify each approved stage and its short detail from plain item snapshots. */
function testApprovedStagePresentations() {
  assert.deepEqual(itemStagePresentation({ status: 'open', blockedBy: [42] }, { gated: true }), { stage: 'Blocked', detail: 'by #42' });
  assert.deepEqual(itemStagePresentation({ status: 'open' }, { gated: true, gateDetail: 'approval pending' }), { stage: 'Blocked', detail: 'approval pending' });
  assert.deepEqual(itemStagePresentation({ status: 'open', route: 'strong' }), { stage: 'Ready', detail: 'strong route' });
  assert.deepEqual(itemStagePresentation({ status: 'open' }), { stage: 'Ready', detail: 'ready for a builder' });
  assert.deepEqual(itemStagePresentation({ status: 'claimed', claim: { by: 'view-1' } }), { stage: 'Building', detail: 'by view-1' });
  assert.deepEqual(itemStagePresentation({ status: 'claimed' }), { stage: 'Building', detail: 'under a build lease' });
  assert.deepEqual(itemStagePresentation({ status: 'submitted', reviewer: 'tests-1' }), { stage: 'In review', detail: 'tests-1 verifying' });
  assert.deepEqual(itemStagePresentation({ status: 'submitted' }), { stage: 'In review', detail: 'awaiting a verdict' });
  assert.deepEqual(itemStagePresentation({ status: 'verified' }), { stage: 'Verified', detail: 'queued for the train' });
  assert.deepEqual(itemStagePresentation({ status: 'verified' }, { landingBatchAt: '2:30 AM' }), { stage: 'Landing', detail: 'in the 2:30 AM batch' });
  assert.deepEqual(itemStagePresentation({ status: 'verified', merged: 'a'.repeat(40) }), { stage: 'Merged', detail: 'landed' });
  assert.deepEqual(itemStagePresentation({ status: 'open', stage: 'merged' }), { stage: 'Merged', detail: 'landed' });
  assert.deepEqual(itemStagePresentation({ status: 'withdrawn', history: [event('submit', 1), event('withdraw', 2)] }), { stage: 'In review', detail: 'awaiting a verdict' });
  assert.deepEqual(itemStagePresentation({ status: 'unknown' }), { stage: 'Ready', detail: 'stage unavailable' });
}

/** Verify stable machine keys for every approved display stage and whitespace normalization. */
function testApprovedStageKeys() {
  assert.deepEqual(['Blocked', 'Ready', 'Building', 'In review', 'Verified', 'Landing', 'Merged'].map(itemStageKey),
    ['blocked', 'ready', 'building', 'in-review', 'verified', 'landing', 'merged']);
  assert.equal(itemStageKey(' In   Review '), '-in-review-');
}

test('withdrawn stage recovery preserves each recorded prior state [N26,N28,N38]', testWithdrawnStageRecovery);
test('stage presentation maps every lifecycle input to its approved word and detail [N26,N28,N38]', testApprovedStagePresentations);
test('stage keys are stable for all approved display words [N26,N28,N38]', testApprovedStageKeys);

test('clause 2: a blocked item says which item blocks it, in the design sheet words [N26,#6870]', () => {
  const blocked = itemStagePresentation({ status: 'open', blockedBy: [5821] }, { gated: true });
  assert.equal(stageSentence(blocked.stage, blocked.detail), 'Blocked by #5821');
  const held = itemStagePresentation({ status: 'open' }, { gated: true });
  assert.deepEqual(held, { stage: 'Blocked', detail: 'on hold' });
  assert.equal(stageSentence(held.stage, held.detail), 'Blocked: on hold');
  assert.equal(stageSentence('Ready', 'strong route'), 'Ready: strong route');
});
