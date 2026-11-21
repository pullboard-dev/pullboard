/** Next order: path, milestone and lane hand-off precedence [N2,B13,B16]. */
import * as queueStore from '../../../../../../packages/store/index.js';
import { openBoard } from '../../../fixtures/board.js';
import {
  roadmap,
  addMilestone,
  editMilestoneItems,
  orderMilestoneItems,
} from '../../../../../../packages/store/index.js';
import { eligibilityProblem as queueEligibility } from '../../../../../../packages/verify/index.js';
import { HOUR } from '../../../fixtures/next/order.js';
import { MID_ITEM_DETAILS } from '../../../fixtures/next/order.js';
import { FREEZE } from '../../../fixtures/next/order.js';
import { boardFixture } from '../../../fixtures/next/order.js';
import { coreItems } from '../../../fixtures/next/order.js';
import { submitted } from '../../../fixtures/next/order.js';
import { REVIEW_ROUTING_ENGINE } from '../../../../../../packages/state/light.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../../packages/store/index.js';
import { workQueue } from '../../../../../../packages/items/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../../../packages/state/index.js';
import {
  ENGINE_VERSION,
  MILESTONE_RANK_ENGINE,
} from '../../../../../../packages/state/index.js';
import { setLineSetting } from '../../../../../../packages/store/index.js';
import { CRITICAL_PATH_ENGINE } from '../../../../../../packages/state/light.js';
import {
  exportBoard,
  importBoard,
} from '../../../../../../packages/store/index.js';
import { resolve } from 'node:path';

test('cli.journeys-next-order.next-offers-the-item-on-the: next offers the item on the longest remaining path first [N2,B13,N20]', async t => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const add = (title, after = []) => store.addItem(board, {
    by: 'coordinator', lane: 'core', title, after, route: 'strong',
  });
  const independent = add('Older independent work');
  const wide = add('A broad but short fan-out');
  const wideChildren = Array.from({ length: 4 }, (_, index) => add(`Short follower ${index}`, [wide]));
  const longest = add('A newer root on the critical chain');
  const middle = add('Middle of the chain', [longest]);
  const end = add('End of the chain', [middle]);
  const outside = add('A path outside the focus');
  const outsideMiddle = add('Outside middle', [outside]);
  const outsideEnd = add('Outside end', [outsideMiddle]);
  const outsideLast = add('Outside last', [outsideEnd]);
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'later', items: [outside, outsideMiddle, outsideEnd, outsideLast] });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'focus', items: [independent, wide, ...wideChildren, longest, middle, end] });
  setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: 'focus',
    reason: 'Synthetic focused DAG scheduling fixture.', window: { items: 14 } });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, wide,
    'ruling 29931: higher (unblocks + 1) / effort wins before the longer path inside the focus');
  assert.equal(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }).first.strong, wide, 'queue and next share the primary score order');
});

/** The sharpened primary score leaves a real equal-score tie for the critical path to resolve. */
test('cli.journeys-next-order.equal-primary-scores-use-the-longer: equal primary scores use the longer remaining path before age [N2,B13,N20]', async t => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const add = (title, after = []) => store.addItem(board, {
    by: 'coordinator', lane: 'core', title, after, route: 'strong',
  });
  const wide = add('Older short fan-out with two successors');
  const children = [add('First short successor', [wide]), add('Second short successor', [wide])];
  const long = add('Newer chain with the same two descendants');
  const middle = add('Chain middle', [long]);
  const end = add('Chain end', [middle]);
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'equal-score focus', items: [wide, ...children, long, middle, end] });
  setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: 'equal-score focus',
    reason: 'Equal-score critical-path tie fixture under ruling 29931.', window: { items: 6 } });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, long,
    'both roots score 3/3; only the remaining path distinguishes them before their age');
  assert.equal(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }).first.strong, long, 'the queue resolves the same equal-score tie');
});

test('cli.journeys-next-order.a-file-overlap-keeps-the-hard: a file overlap keeps the hard collision skip under the sharpened precedence [N2,N20]', async t => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const busy = store.register(board, { lane: 'api', path: '/soft-overlap', route: 'strong' });
  const active = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'A live shared file', brief: 'Files: src/shared.js' });
  store.claim(board, active, { agentId: busy, lane: 'api', leaseMs: HOUR, freeze: FREEZE });
  const colliding = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Ready overlapping work', brief: 'Files: src/shared.js' });
  const only = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(only.item.item_id, colliding, 'the colliding item is the only ready work, so next offers it as an overlap (claim warns, never refuses)');
  assert.ok(only.reasons.some(reason => reason.startsWith('overlap: ') && reason.includes('src/shared.js')), 'the offer names its overlap');
  assert.equal(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }).first.strong, null, 'queue and next both retain the collision block');
  assert.ok(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }).releases.flatMap(release => release.items).concat(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }).unreleased)
    .find(item => item.id === colliding).waits.length > 0, 'the blocked offer still explains its live collision');
  const free = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Equally short independent work', brief: 'Files: src/free.js' });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, free,
    'an independent item remains offerable while the collision stays blocked');
});

test('cli.journeys-next-order.historical-review-paths-replay-while-modern: historical review paths replay while modern reviews use age [C7,N2,B13,H16]', async t => {
  const { board, builder, reviewer } = boardFixture();
  t.after(() => store.closeBoard(board));
  const independent = submitted(board, builder, 'Older independent submission', 'strong', 1);
  const root = submitted(board, builder, 'Newer submission unlocks follow-up work', 'strong', 2);
  const follower = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Follow-up waits for review', after: [root] });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'focus', items: [independent, root, follower] });
  setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: 'focus',
    reason: 'Synthetic review critical-chain fixture.', window: { items: 3 } });
  board.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item.item_id, root,
    'review offers also advance the longer remaining path with the separate line.order switch off');
  delete board.executionEngineVersion;
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item.item_id, independent,
    'modern review age precedes the critical path under coordinator37962');
});

test('cli.journeys-next-order.recorded-review-selection-keeps-its-historical: recorded review selection keeps its historical path priority on replay [N2,H16]', async t => {
  for (const engine of [CRITICAL_PATH_ENGINE - 1, REVIEW_ROUTING_ENGINE - 1, ENGINE_VERSION]) {
    const { board, builder, reviewer } = boardFixture(engine);
    const replica = openBoard(':memory:');
    t.after(() => { store.closeBoard(board); store.closeBoard(replica); });
    const independent = submitted(board, builder, 'Older independent review', 'strong', 1);
    const root = submitted(board, builder, 'Review that unlocks a longer path', 'strong', 2);
    const follower = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Blocked follow-up', after: [root] });
    addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'focus', items: [independent, root, follower] });
    setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: 'focus',
      reason: 'Synthetic old/current selection replay fixture.', window: { items: 3 } });
    importBoard(replica, exportBoard(board));
    delete board.executionEngineVersion;
    const prepared = prepareEngineMove(board, 'reserveNextReview', [{ agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' }]);
    const move = { ...prepared, engine };
    const receipt = { sequence: 1, at: '2026-10-25T12:00:00Z' };
    const outcomes = [board, replica].map(current => applyEngineMove(current, move, receipt));
    assert.equal(outcomes[0].error, undefined, JSON.stringify(outcomes[0]));
    assert.deepEqual(outcomes[0], outcomes[1], 'independent SQLite replicas select and record the same offer');
    assert.equal(outcomes[0].result.item.item_id, engine < CRITICAL_PATH_ENGINE || engine >= REVIEW_ROUTING_ENGINE ? independent : root,
      'each engine retains its original age, path, or modern age selection');
    for (const current of [board, replica]) {
      const count = store.events(current).length;
      assert.deepEqual(applyEngineMove(current, move, receipt), outcomes[0], 'same move identity reuses its immutable outcome');
      assert.equal(store.events(current).length, count, 'receipt replay appends no duplicate reservation');
    }
  }
});

test('cli.journeys-next-order.historical-reviewers-keep-earliest-milestone-submissions: historical reviewers keep earliest-milestone submissions first [B16,H16]', async (t) => {
  const { board, builder, reviewer } = boardFixture();
  board.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
  t.after(() => store.closeBoard(board));

  const laterStrong = submitted(board, builder, 'later milestone strong', 'strong', 1);
  const earliestMid = submitted(board, builder, 'earliest milestone mid', 'mid', 2);
  const unlistedStrong = submitted(board, builder, 'unlisted strong', 'strong', 3);
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.8.4', items: [earliestMid] });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.8.5', items: [laterStrong] });

  const first = store.reserveNextReview(board, { agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' });
  assert.equal(first.item.item_id, earliestMid, 'roadmap position precedes the stronger later release');

  store.release(board, earliestMid, reviewer, 'preserve the existing review cooldown', 'ROUTED_ELSEWHERE');
  const second = store.reserveNextReview(board, { agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' });
  assert.equal(second.item.item_id, laterStrong, 'the existing cooldown still skips the released review');

  const otherReviewer = store.register(board, { lane: 'review', path: '/reviewer-2', route: 'strong' });
  store.reserveReview(board, unlistedStrong, { agentId: otherReviewer, leaseMs: HOUR, policy: 'any' });
  const held = store.nextFor(board, { agentId: otherReviewer, lane: 'review', verify: true });
  assert.equal(held.item.item_id, unlistedStrong, 'a reviewer still resumes its own held review');

  const sameMilestoneStrong = submitted(board, builder, 'same milestone strong', 'strong', 4);
  editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', reason: 'Arrange fixture release', add: [sameMilestoneStrong] });
  const thirdReviewer = store.register(board, { lane: 'review', path: '/reviewer-3', route: 'strong' });
  const newerStrong = submitted(board, builder, 'newer same milestone strong', 'strong', 5);
  editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', reason: 'Arrange fixture release', add: [newerStrong] });
  const sameRelease = store.nextFor(board, { agentId: thirdReviewer, lane: 'review', verify: true });
  assert.equal(sameRelease.item.item_id, sameMilestoneStrong, 'route-tier then oldest order remains within one milestone');
});

test('cli.journeys-next-order.a-builder-gets-the-earliest-milestone: a builder gets the earliest milestone\'s open items first [B16]', async (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));

  const laterStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'later milestone strong', route: 'strong' });
  const earliestMid = store.addItem(board, {
    by: 'coordinator', lane: 'core', title: 'earliest milestone mid', route: 'mid', ...MID_ITEM_DETAILS,
  });
  const unlistedStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'unlisted strong', route: 'strong' });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.8.4', items: [earliestMid] });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.8.5', items: [laterStrong] });

  const first = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(first.item.item_id, earliestMid, 'roadmap position precedes the stronger later release');

  const sameMilestoneStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'same milestone strong', route: 'strong' });
  if (!store.milestones(board).find(m => m.name === '0.8.4').items.includes(sameMilestoneStrong)) {
    editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', reason: 'Arrange fixture release', add: [sameMilestoneStrong] });
  }
  const newerStrong = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'newer same milestone strong', route: 'strong' });
  if (!store.milestones(board).find(m => m.name === '0.8.4').items.includes(newerStrong)) {
    editMilestoneItems(board, '0.8.4', { agentId: 'coordinator', reason: 'Arrange fixture release', add: [newerStrong] });
  }
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, earliestMid,
    'current selection keeps the coordinator-ranked item first');
  board.executionEngineVersion = MILESTONE_RANK_ENGINE - 1;
  const sameRelease = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(sameRelease.item.item_id, sameMilestoneStrong, 'route-tier then oldest order remains within one milestone');
  delete board.executionEngineVersion;

  store.claim(board, sameMilestoneStrong, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const resumed = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(resumed.item.item_id, sameMilestoneStrong, 'an existing held claim still resumes first');
  assert.notEqual(resumed.item.item_id, unlistedStrong);
});

test('cli.journeys-next-order.a-pinned-eligible-item-is-offered: a pinned eligible item is offered before an older unpinned one [B16,N2]', async (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const [older, pinned] = coreItems(board, [{ title: 'older unpinned work' }, { title: 'newer pinned work' }]);
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.8.4', items: [older, pinned] });
  orderMilestoneItems(board, '0.8.4', { agentId: 'coordinator', reason: 'Arrange fixture release', items: [pinned] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, pinned,
    'the pinned item leads the milestone although an older item is also open');
});

test('cli.journeys-next-order.a-pinned-item-whose-dependency-is: a pinned item whose dependency is open is skipped [B16,N2]', async (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const [, pinned, free] = coreItems(board, [{ title: 'open prerequisite elsewhere' }, { title: 'pinned but waiting', after: [0] }, { title: 'unpinned ready work' }]);
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.8.4', items: [pinned, free] });
  orderMilestoneItems(board, '0.8.4', { agentId: 'coordinator', reason: 'Arrange fixture release', items: [pinned] });
  const offered = store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id;
  assert.notEqual(offered, pinned, 'a pinned item still waiting on an open dependency is not offered');
  assert.equal(offered, free, 'the next eligible item in the milestone is offered instead');
});

test('cli.journeys-next-order.recorded-reserve-next-moves-retain-their: recorded reserve-next moves retain their versioned ordering [B16,H16]', async (t) => {
  assert.ok(ENGINE_VERSION >= 8, 'roadmap selection is carried by engine 8 or newer');
  for (const version of [1, 2, 3, 4, 5, 6, 7, ENGINE_VERSION]) {
    const { board, builder, reviewer } = boardFixture(version);
    t.after(() => store.closeBoard(board));
    const laterStrong = submitted(board, builder, 'later strong', 'strong', 1);
    const earliestMid = submitted(board, builder, 'earliest mid', 'mid', 2);
    addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'first', items: [earliestMid] });
    addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'later', items: [laterStrong] });
    delete board.executionEngineVersion;
    const move = prepareEngineMove(board, 'reserveNextReview', [{ agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' }]);
    assert.equal(move.engine, ENGINE_VERSION, 'new moves carry the current engine');
    const outcome = applyEngineMove(board, { ...move, engine: version }, { sequence: 1, at: new Date().toISOString() });
    assert.equal(outcome.error, undefined, JSON.stringify(outcome.error));
    assert.equal(outcome.result.item.item_id, version < 8 || version >= REVIEW_ROUTING_ENGINE ? laterStrong : earliestMid, `engine ${version} retains its recorded selection`);
  }
});
