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
  set('focusOverflow', true);
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
  set('focusOverflow', true);
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item.item_id, later);
});
