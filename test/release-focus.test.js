import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { addMilestone } from '../src/board-milestones.js';
import { setLineSetting } from '../src/board-line-settings.js';
import { boardFixture, submitted, HOUR, FREEZE } from './next-order-fixture.js';

function setup(t) {
  const { board, builder, reviewer } = boardFixture();
  t.after(() => store.closeBoard(board));
  const set = (key, value) => setLineSetting(board, { agentId: 'coordinator', key, value, reason: 'Finish the release', window: { activeItems: 2 } });
  return { board, builder, reviewer, set };
}

test('with focus set and overflow off, next never offers a later release [B26,C7]', t => {
  const { board, builder, set } = setup(t);
  const later = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Later' });
  const focus = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Focused' });
  addMilestone(board, { agentId: 'coordinator', reason: 'Set up focus', name: '0.9.3', items: [focus] });
  set('focusMilestone', '0.9.3');
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, focus);
  const peer = store.register(board, { lane: 'core', path: '/peer', route: 'strong' });
  store.claim(board, focus, { agentId: peer, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const result = store.nextFor(board, { agentId: builder, lane: 'core', observeIdle: true });
  assert.equal(result.item, null);
  assert.ok(result.reasons.includes('0.9.3 is in focus; nothing is free for you; overflow is off.'));
  assert.equal(store.getItem(board, later).item_status, 'open');
});

test('with overflow on, next offers a later release only when the focused one has nothing for the seat [B26,C7]', t => {
  const { board, builder, set } = setup(t);
  const later = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Later' });
  const focus = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Focused' });
  addMilestone(board, { agentId: 'coordinator', reason: 'Set up focus', name: '0.9.3', items: [focus] });
  set('focusMilestone', '0.9.3');
  set('focusMilestone', { name: '0.9.3', overflow: true });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, focus);
  const peer = store.register(board, { lane: 'core', path: '/peer', route: 'strong' });
  store.claim(board, focus, { agentId: peer, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, later);
});

test('reviews follow the same focus [B26,C7]', t => {
  const { board, builder, reviewer, set } = setup(t);
  const later = submitted(board, builder, 'Later review', 'strong', 1);
  const focus = submitted(board, builder, 'Focused review', 'strong', 2);
  addMilestone(board, { agentId: 'coordinator', reason: 'Set up focus', name: '0.9.3', items: [focus] });
  set('focusMilestone', '0.9.3');
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item.item_id, focus);
  const peer = store.register(board, { lane: 'review', path: '/peer-review', route: 'strong' });
  store.reserveReview(board, focus, { agentId: peer, lane: 'review', leaseMs: HOUR, policy: 'any' });
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item, null);
  set('focusMilestone', { name: '0.9.3', overflow: true });
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item.item_id, later);
});

test('focused draft rows form one approval batch for unlanded items [B26,C7]', async () => {
  const { personNeeds } = await import('../packages/spec/index.js');
  const needs = personNeeds({ focusMilestone: { name: '0.9.3', items: [1, 2, 3, 4] },
    items: [
      { id: 1, status: 'open', specs: ['A1', 'B1'] },
      { id: 2, status: 'submitted', specs: ['A1'] },
      { id: 3, status: 'verified', merged: 'abc', specs: ['C1'] },
      { id: 4, status: 'withdrawn', specs: ['D1'] },
    ], spec: [{ id: 'A1', status: 'draft', text: 'A' }, { id: 'C1', status: 'draft', text: 'C' },
      { id: 'D1', status: 'draft', text: 'D' }], practice: [{ id: 'B1', status: 'draft', text: 'B' }] });
  const batches = needs.filter(row => row.kind === 'focus-approval-batch');
  assert.deepEqual(batches, [{ kind: 'focus-approval-batch', id: 'focus-approval:0.9.3', ref: '0.9.3',
    text: 'Draft rows blocking 0.9.3 need your approval.', rows: [
      { id: 'A1', kind: 'spec', text: 'A', items: [1, 2] },
      { id: 'B1', kind: 'doctrine', text: 'B', items: [1] },
    ] }]);
});

test('overflow checks focused builds and reviews together [B26,C7]', t => {
  const { board, builder, set } = setup(t);
  const actor = store.register(board, { lane: 'core', path: '/mixed', route: 'strong' });
  const focusedReview = submitted(board, builder, 'Focused review', 'strong', 3);
  const laterBuild = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Later build' });
  addMilestone(board, { agentId: 'coordinator', reason: 'Set up focus', name: '0.9.3', items: [focusedReview] });
  set('focusMilestone', { name: '0.9.3', overflow: true });
  assert.equal(store.nextFor(board, { agentId: actor, lane: 'core' }).item, null, 'an eligible focused review blocks an outside build');
  assert.equal(store.nextFor(board, { agentId: actor, lane: 'core', verify: true }).item.item_id, focusedReview);
  store.reserveReview(board, focusedReview, { agentId: actor, lane: 'core', leaseMs: HOUR, policy: 'any' });
  assert.equal(store.getItem(board, laterBuild).item_status, 'open');
});
