import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { addMilestone } from '../../../../packages/store/index.js';
import { setLineSetting } from '../../../../packages/store/index.js';
import { boardFixture } from '../../tests/fixtures/next/order.js';
import { submitted } from '../../tests/fixtures/next/order.js';
import { HOUR } from '../../tests/fixtures/next/order.js';
import { FREEZE } from '../../tests/fixtures/next/order.js';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';
import { openBoard } from '../../../lib/index.js';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

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
  const { personNeeds } = await import('../../../../packages/spec/index.js');
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

test('real project state feeds focused draft rows into one Needs-you batch [B26,C7]', async t => {
  const box = crossLaneFixture(t);
  const item = box.add('web', 'Needs the focused row');
  box.milestone('0.9.3', item);
  box.json(await box.inProcess(box.repo, 'milestone', 'focus', '0.9.3', '--json'));
  const spec = join(box.repo, 'SPEC.md');
  writeFileSync(spec, readFileSync(spec, 'utf8').replace('G1 [approved, must]', 'G1 [draft, must]'));
  const { projectState } = await import('../../../view/index.js');
  const { personNeeds } = await import('../../../../packages/spec/index.js');
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    const state = projectState(box.repo, { board });
    assert.deepEqual(state.focusMilestone, { name: '0.9.3', items: [item] });
    const batches = personNeeds(state).filter(need => need.kind === 'focus-approval-batch');
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].rows, [{ id: 'G1', kind: 'spec', text: 'The page renders.', items: [item] }]);
  } finally { store.closeBoard(board); }
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

test('an available focused build prevents an outside review with overflow on [B26,C7]', t => {
  const { board, builder, set } = setup(t);
  const actor = store.register(board, { lane: 'core', path: '/mixed-review', route: 'strong' });
  const later = submitted(board, builder, 'Later review', 'strong', 4);
  const focus = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Focused build' });
  addMilestone(board, { agentId: 'coordinator', reason: 'Set up focus', name: '0.9.3', items: [focus] });
  set('focusMilestone', { name: '0.9.3', overflow: true });
  assert.equal(store.nextFor(board, { agentId: actor, lane: 'core', verify: true }).item, null);
  assert.equal(store.nextFor(board, { agentId: actor, lane: 'core' }).item.item_id, focus);
  assert.equal(store.getItem(board, later).item_status, 'submitted');
});

test('focus does not displace work already held by the seat [B26,C7]', t => {
  const { board, builder, set } = setup(t);
  const held = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Already claimed' });
  const focus = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Focused' });
  store.claim(board, held, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  addMilestone(board, { agentId: 'coordinator', reason: 'Set up focus', name: '0.9.3', items: [focus] });
  set('focusMilestone', { name: '0.9.3', overflow: false });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, held);
});

test('milestone focus records the one-line idle observation and clearing restores ordering [B26,C7]', async t => {
  const box = crossLaneFixture(t);
  const actor = box.seat('focus-owner', 'web', box.session);
  const peer = box.seat('focus-peer', 'web', 'focus-peer');
  const later = box.add('web', 'Later');
  const focused = box.add('web', 'Focused');
  box.milestone('0.9.3', focused);
  box.json(await box.inProcess(box.repo, 'milestone', 'focus', '0.9.3', '--json'));
  box.json(await box.runAsLocal('focus-peer', peer.root, 'claim', String(focused), '--json'));
  const idle = await box.runAsLocal(box.session, actor.root, 'next', '--build');
  assert.equal(idle.code, 0, idle.err);
  assert.deepEqual(idle.out.trim().split('\n'), ['0.9.3 is in focus; nothing is free for you; overflow is off.']);
  const reviewIdle = await box.runAsLocal(box.session, actor.root, 'next', '--verify');
  assert.equal(reviewIdle.code, 0, reviewIdle.err);
  assert.deepEqual(reviewIdle.out.trim().split('\n'), ['0.9.3 is in focus; nothing is free for you; overflow is off.']);
  const takeIdle = await box.runAsLocal(box.session, actor.root, 'next', '--take');
  assert.equal(takeIdle.code, 0, takeIdle.err);
  assert.deepEqual(takeIdle.out.trim().split('\n'), ['0.9.3 is in focus; nothing is free for you; overflow is off.']);
  // @pullboard-board-file journey: the real CLI in this fixture repo owns the board file; the test seeds or reads that same file.
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.ok(store.events(board).some(event => event.event_kind === 'next-idle' && JSON.parse(event.event_detail).reason === 'focus'));
  } finally { store.closeBoard(board); }
  box.json(await box.inProcess(box.repo, 'milestone', 'focus', 'off', '--json'));
  assert.equal(box.json(await box.runAsLocal(box.session, actor.root, 'next', '--build', '--json')).item.item_id, later);
});
