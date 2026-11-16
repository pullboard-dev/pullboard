/** Focus never hides finished, green-gated work from review, while builds stay inside the focus [C7, #2961]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recordSubmitHandoff } from '../../jobs/index.js';
import * as store from '../index.js';
import { register } from '../index.js';
import { fixtureBoard } from '../../board/tests/fixtures/board.js';
import { submitFixture } from './fixtures/submit.js';
import { cellItem } from './fixtures/cell.js';

const HOUR = 60 * 60 * 1000;
/** The minimal frozen bar a claim needs. */
const FREEZE = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/** A coordinator plus one strong builder and one strong reviewer on a real in-memory board. */
function boardFixture(t) {
  const board = fixtureBoard(t);
  register(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = register(board, { lane: 'core', path: '/builder', route: 'strong' });
  const reviewer = register(board, { lane: 'review', path: '/reviewer', route: 'strong' });
  return { board, builder, reviewer };
}

/** Add an item and submit it through the board's normal claim and submit moves. */
function submitted(board, builder, title, route, number) {
  const id = cellItem(board, { lane: 'core', title, route }).item_id;
  store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const hash = String(number).repeat(40);
  submitFixture(board, id, { agentId: builder, commit: hash, tree: hash });
  return id;
}

/**
 * A real board plus a step that puts focus on 0.9.3 with overflow off. The 0.9.3 milestone holds one
 * focused item; the caller adds its outside items first, since the setting's window counts later work.
 */
function focusedBoard(t) {
  const { board, builder, reviewer } = boardFixture(t);
  const focused = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Focused' });
  /** Turn focus on with overflow off. */
  const focus = () => {
    store.addMilestone(board, { agentId: 'coordinator', reason: 'Set up focus', name: '0.9.3', items: [focused] });
    store.setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: { name: '0.9.3', overflow: false },
      reason: 'Finish the release', window: { activeItems: 2 } });
  };
  return { board, builder, reviewer, focused, focus };
}

/** Record a green gate at the item's submitted head, the way the submit queue does. */
function green(board, id) {
  const item = store.getItem(board, id);
  const { item_commit: head, item_tree: tree, item_frozen_digest: digest, item_built_by: builder } = item;
  recordSubmitHandoff(board.db, id, { id: `fixture-${id}`, commit: head, executionCommit: head,
    executionTree: tree, digest, agentId: builder, state: 'green' });
  store.logEvent(board, builder, 'proof-run', id, { receipt: { id: `proof-${id}`, kind: 'submit', item: id,
    commit: head, tree, frozenDigest: digest, seat: builder, sourceClean: true, exitCode: 0,
    counts: { passed: 1, failed: 0, skipped: 0 }, failures: [] } });
}

test('with focus on and overflow off, next --verify still offers a green submission outside the focus [C7,#2961]', t => {
  const { board, builder, reviewer, focus } = focusedBoard(t);
  const outside = submitted(board, builder, 'Outside review', 'strong', 5);
  focus();
  assert.ok(store.getItem(board, outside).item_commit, 'the submission records its head');
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item, null, 'an ungated outside submission stays behind the focus');
  green(board, outside);
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item?.item_id, outside);
});

test('next never offers an out-of-focus open item to build while focus is on and overflow is off [C7,#2961]', t => {
  const { board, builder, focused, focus } = focusedBoard(t);
  const outside = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Outside build' });
  focus();
  const peer = store.register(board, { lane: 'core', path: '/peer', route: 'strong' });
  store.claim(board, focused, { agentId: peer, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const result = store.nextFor(board, { agentId: builder, lane: 'core', observeIdle: true });
  assert.equal(result.item, null);
  assert.ok(result.reasons.includes('0.9.3 is in focus; nothing is free for you; overflow is off.'), result.reasons.join(' | '));
  assert.equal(store.getItem(board, outside).item_status, 'open');
});

/** A board whose focus milestone holds one submitted strong item, with a light seat and a strong reviewer ready to ask next --verify. */
function strongReviewWaiting(t) {
  const { board, builder, reviewer } = boardFixture(t);
  const light = register(board, { lane: 'review', path: '/light', route: 'light' });
  const waiting = submitted(board, builder, 'Strong review waits', 'strong', 6);
  store.addMilestone(board, { agentId: 'coordinator', reason: 'Set up focus', name: '0.9.3', items: [waiting] });
  store.setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: { name: '0.9.3', overflow: false },
    reason: 'Finish the release', window: { activeItems: 2 } });
  green(board, waiting);
  return { board, light, reviewer, waiting };
}

test('clause 1: a light seat in a focused milestone with only strong reviews waiting is told which items and that a strong seat reviews them [B16,B13,#3102]', t => {
  const { board, light, waiting } = strongReviewWaiting(t);
  const result = store.nextFor(board, { agentId: light, lane: 'review', verify: true, observeIdle: true });
  assert.equal(result.item, null);
  const text = result.reasons.join(' | ');
  assert.ok(text.includes(`#${waiting}`), text);
  assert.match(text, /strong seat to review/u);
  assert.doesNotMatch(text, /^0\.9\.3 is in focus; nothing is free for you/u, 'the bare nothing-is-free line is replaced');
});

test('clause 2: a light seat never reserves a strong review, while a strong seat still gets it [B16,B13,#3102]', t => {
  const { board, light, reviewer, waiting } = strongReviewWaiting(t);
  assert.equal(store.nextFor(board, { agentId: light, lane: 'review', verify: true }).item, null);
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item?.item_id, waiting);
});
