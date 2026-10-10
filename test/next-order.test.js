/** Roadmap position leads next's existing route order only across unfinished milestones [B16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { applyEngineMove, prepareEngineMove } from '../src/engine.js';
import { ENGINE_VERSION } from '../src/machine.js';

const HOUR = 60 * 60 * 1000;
const MID_ITEM_DETAILS = {
  criterion: 'the item can be built and checked from its brief',
  check: 'true',
  brief: 'Files: src/board.js\nTest: verify the candidate follows the release roadmap',
};
/** Build the minimal frozen bar required to submit a fixture item. */
const FREEZE = (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` });

/** Open a real SQLite board and register a coordinator plus strong builder and reviewer agents. */
function boardFixture() {
  const board = store.openBoard(':memory:');
  store.register(board, { lane: 'coordinator', path: '/coordinator' });
  const builder = store.register(board, { lane: 'core', path: '/builder', route: 'strong' });
  const reviewer = store.register(board, { lane: 'review', path: '/reviewer', route: 'strong' });
  return { board, builder, reviewer };
}

/** Add and submit an item through the board's normal claim and submit moves. */
function submitted(board, builder, title, route, number) {
  const id = store.addItem(board, {
    by: 'coordinator', lane: 'core', title, route,
    ...(route === 'mid' ? MID_ITEM_DETAILS : {}),
  });
  store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const hash = String(number).repeat(40);
  store.submit(board, id, { agentId: builder, commit: hash, tree: hash });
  return id;
}

test('a reviewer gets the earliest milestone\'s submissions first [B16]', (t) => {
  const { board, builder, reviewer } = boardFixture();
  t.after(() => store.closeBoard(board));

  const laterStrong = submitted(board, builder, 'later milestone strong', 'strong', 1);
  const earliestMid = submitted(board, builder, 'earliest milestone mid', 'mid', 2);
  const unlistedStrong = submitted(board, builder, 'unlisted strong', 'strong', 3);
  store.addMilestone(board, { agentId: 'coordinator', name: '0.8.4', items: [earliestMid] });
  store.addMilestone(board, { agentId: 'coordinator', name: '0.8.5', items: [laterStrong] });

  const first = store.reserveNextReview(board, { agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' });
  assert.equal(first.item.item_id, earliestMid, 'roadmap position precedes the stronger later release');

  store.release(board, earliestMid, reviewer, 'preserve the existing review cooldown');
  const second = store.reserveNextReview(board, { agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' });
  assert.equal(second.item.item_id, laterStrong, 'the existing cooldown still skips the released review');

  const otherReviewer = store.register(board, { lane: 'review', path: '/reviewer-2', route: 'strong' });
  store.reserveReview(board, unlistedStrong, { agentId: otherReviewer, leaseMs: HOUR, policy: 'any' });
  const held = store.nextFor(board, { agentId: otherReviewer, lane: 'review', verify: true });
  assert.equal(held.item.item_id, unlistedStrong, 'a reviewer still resumes its own held review');

  const sameMilestoneStrong = submitted(board, builder, 'same milestone strong', 'strong', 4);
  store.editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', add: [sameMilestoneStrong] });
  const thirdReviewer = store.register(board, { lane: 'review', path: '/reviewer-3', route: 'strong' });
  const newerStrong = submitted(board, builder, 'newer same milestone strong', 'strong', 5);
  store.editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', add: [newerStrong] });
  const sameRelease = store.nextFor(board, { agentId: thirdReviewer, lane: 'review', verify: true });
  assert.equal(sameRelease.item.item_id, sameMilestoneStrong, 'route-tier then oldest order remains within one milestone');
});

test('a builder gets the earliest milestone\'s open items first [B16]', (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));

  const laterStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'later milestone strong', route: 'strong' });
  const earliestMid = store.addItem(board, {
    by: 'coordinator', lane: 'core', title: 'earliest milestone mid', route: 'mid', ...MID_ITEM_DETAILS,
  });
  const unlistedStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'unlisted strong', route: 'strong' });
  store.addMilestone(board, { agentId: 'coordinator', name: '0.8.4', items: [earliestMid] });
  store.addMilestone(board, { agentId: 'coordinator', name: '0.8.5', items: [laterStrong] });

  const first = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(first.item.item_id, earliestMid, 'roadmap position precedes the stronger later release');

  const sameMilestoneStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'same milestone strong', route: 'strong' });
  store.editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', add: [sameMilestoneStrong] });
  const newerStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'newer same milestone strong', route: 'strong' });
  store.editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', add: [newerStrong] });
  const sameRelease = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(sameRelease.item.item_id, sameMilestoneStrong, 'route-tier then oldest order remains within one milestone');

  store.claim(board, sameMilestoneStrong, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const resumed = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(resumed.item.item_id, sameMilestoneStrong, 'an existing held claim still resumes first');
  assert.notEqual(resumed.item.item_id, unlistedStrong);
});

test('recorded reserve-next moves retain their versioned ordering [B16,H16]', (t) => {
  assert.ok(ENGINE_VERSION >= 8, 'roadmap selection is carried by engine 8 or newer');
  for (const version of [1, 2, 3, 4, 5, 6, 7, ENGINE_VERSION]) {
    const { board, builder, reviewer } = boardFixture();
    t.after(() => store.closeBoard(board));
    const laterStrong = submitted(board, builder, 'later strong', 'strong', 1);
    const earliestMid = submitted(board, builder, 'earliest mid', 'mid', 2);
    store.addMilestone(board, { agentId: 'coordinator', name: 'first', items: [earliestMid] });
    store.addMilestone(board, { agentId: 'coordinator', name: 'later', items: [laterStrong] });
    const move = prepareEngineMove(board, 'reserveNextReview', [{ agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' }]);
    assert.equal(move.engine, ENGINE_VERSION, 'new moves carry the current engine');
    const outcome = applyEngineMove(board, { ...move, engine: version }, { sequence: 1, at: new Date().toISOString() });
    assert.equal(outcome.error, undefined, JSON.stringify(outcome.error));
    assert.equal(outcome.result.item.item_id, version < 8 ? laterStrong : earliestMid, `engine ${version} retains its recorded selection`);
  }
});
