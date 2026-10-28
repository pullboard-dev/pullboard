import * as queueStore from '../src/board.js';
import { eligibilityProblem as queueEligibility } from '../src/review-eligibility.js';
import { crossLaneFixture } from './e2e-helpers.js';
import { HOUR } from './next-order-fixture.js';
import { MID_ITEM_DETAILS } from './next-order-fixture.js';
import { FREEZE } from './next-order-fixture.js';
import { boardFixture } from './next-order-fixture.js';
import { submitted } from './next-order-fixture.js';
import { lineOrderFixture } from './next-order-fixture.js';
import { REVIEW_ROUTING_ENGINE } from '../src/review-routing-engine.js';
/** Roadmap position leads next's existing route order only across unfinished milestones [B16]. */
import { submitFixture } from './board-submit-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { workQueue } from '../src/queue.js';
import { applyEngineMove, applyRelayMove, prepareEngineMove } from '../src/engine.js';
import { ENGINE_VERSION, MILESTONE_RANK_ENGINE } from '../src/machine.js';
import { LINE_ORDER_ENGINE } from '../src/line-order-engine.js';
import { setLineSetting } from '../src/line-settings.js';
import { FOCUS_MILESTONE_ENGINE } from '../src/focus-milestone-engine.js';
import { CRITICAL_PATH_ENGINE } from '../src/critical-path-engine.js';
import { exportBoard, importBoard } from '../src/exchange.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

test('next offers the item on the longest remaining path first [N2,B13,N20]', t => {
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
  store.addMilestone(board, { agentId: 'coordinator', name: 'later', items: [outside, outsideMiddle, outsideEnd, outsideLast] });
  store.addMilestone(board, { agentId: 'coordinator', name: 'focus', items: [independent, wide, ...wideChildren, longest, middle, end] });
  setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: 'focus',
    reason: 'Synthetic focused DAG scheduling fixture.', window: { items: 14 } });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, wide,
    'ruling 29931: higher (unblocks + 1) / effort wins before the longer path inside the focus');
  assert.equal(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: queueStore.roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }).first.strong, wide, 'queue and next share the primary score order');
});

/** The sharpened primary score leaves a real equal-score tie for the critical path to resolve. */
test('equal primary scores use the longer remaining path before age [N2,B13,N20]', t => {
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
  store.addMilestone(board, { agentId: 'coordinator', name: 'equal-score focus', items: [wide, ...children, long, middle, end] });
  setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: 'equal-score focus',
    reason: 'Equal-score critical-path tie fixture under ruling 29931.', window: { items: 6 } });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, long,
    'both roots score 3/3; only the remaining path distinguishes them before their age');
  assert.equal(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: queueStore.roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }).first.strong, long, 'the queue resolves the same equal-score tie');
});

test('a file overlap keeps the hard collision skip under the sharpened precedence [N2,N20]', t => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const busy = store.register(board, { lane: 'api', path: '/soft-overlap', route: 'strong' });
  const active = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'A live shared file', brief: 'Files: src/shared.js' });
  store.claim(board, active, { agentId: busy, lane: 'api', leaseMs: HOUR, freeze: FREEZE });
  const colliding = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Ready overlapping work', brief: 'Files: src/shared.js' });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item, null,
    'ruling 29931 retains the hard collision skip even when the colliding item is the only ready work');
  assert.equal(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: queueStore.roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }).first.strong, null, 'queue and next both retain the collision block');
  assert.ok(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: queueStore.roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }).releases.flatMap(release => release.items).concat(workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: queueStore.roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility }).unreleased)
    .find(item => item.id === colliding).waits.length > 0, 'the blocked offer still explains its live collision');
  const free = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Equally short independent work', brief: 'Files: src/free.js' });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, free,
    'an independent item remains offerable while the collision stays blocked');
});

test('historical review paths replay while modern reviews use age [C7,N2,B13,H16]', t => {
  const { board, builder, reviewer } = boardFixture();
  t.after(() => store.closeBoard(board));
  const independent = submitted(board, builder, 'Older independent submission', 'strong', 1);
  const root = submitted(board, builder, 'Newer submission unlocks follow-up work', 'strong', 2);
  const follower = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Follow-up waits for review', after: [root] });
  store.addMilestone(board, { agentId: 'coordinator', name: 'focus', items: [independent, root, follower] });
  setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: 'focus',
    reason: 'Synthetic review critical-chain fixture.', window: { items: 3 } });
  board.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item.item_id, root,
    'review offers also advance the longer remaining path with the separate line.order switch off');
  delete board.executionEngineVersion;
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item.item_id, independent,
    'modern review age precedes the critical path under coordinator37962');
});

test('recorded review selection keeps its historical path priority on replay [N2,H16]', t => {
  for (const engine of [CRITICAL_PATH_ENGINE - 1, REVIEW_ROUTING_ENGINE - 1, ENGINE_VERSION]) {
    const { board, builder, reviewer } = boardFixture();
    const replica = store.openBoard(':memory:');
    t.after(() => { store.closeBoard(board); store.closeBoard(replica); });
    const independent = submitted(board, builder, 'Older independent review', 'strong', 1);
    const root = submitted(board, builder, 'Review that unlocks a longer path', 'strong', 2);
    const follower = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Blocked follow-up', after: [root] });
    store.addMilestone(board, { agentId: 'coordinator', name: 'focus', items: [independent, root, follower] });
    setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: 'focus',
      reason: 'Synthetic old/current selection replay fixture.', window: { items: 3 } });
    importBoard(replica, exportBoard(board));
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

test('historical reviewers keep earliest-milestone submissions first [B16,H16]', (t) => {
  const { board, builder, reviewer } = boardFixture();
  board.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
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
    assert.equal(outcome.result.item.item_id, version < 8 || version >= REVIEW_ROUTING_ENGINE ? laterStrong : earliestMid, `engine ${version} retains its recorded selection`);
  }
});

test('next in the main checkout names the lane worktree to join [N2,B26]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox(), repo = join(box.dir, 'fresh-board');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const model = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  assert.equal(box.run(repo, 'init').code, 0);
  if (model !== undefined) box.env.PULLBOARD_MODEL = model;
  assert.equal(box.run(repo, 'lane', 'add', 'app', '--owns', 'app/').code, 0);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up the fresh board');
  for (const title of ['First app item', 'Second app item']) {
    const added = box.run(repo, 'add', 'app', title, '--route', 'strong',
      '--criterion', 'The app item creates its readiness marker.', '--check', 'test -f app/ready', '--json');
    assert.equal(added.code, 0, `${added.out}\n${added.err}`);
  }
  const json = box.run(repo, 'next', '--json');
  assert.equal(json.code, 1, json.out);
  const refusal = JSON.parse(json.out).error;
  assert.equal(refusal.code, 'NOTHING_FREE', 'the empty coordinator queue keeps its refusal code');
  assert.match(refusal.message, /2 items open in lane app/u);
  assert.equal(refusal.next, 'pullboard worktree app --model "<model name>"');
  assert.doesNotMatch(refusal.message + refusal.next, /wait|keep looking/iu);
  for (const args of [[], ['--wait', '0.01']]) {
    const text = box.run(repo, 'next', ...args);
    assert.equal(text.code, 1);
    assert.match(text.err, /2 items open in lane app/u);
    assert.match(text.err, /pullboard worktree app --model "<model name>"/u);
    assert.doesNotMatch(text.err, /pullboard next --wait|keep looking/iu);
  }
  const opened = box.run(repo, 'worktree', 'app', '--model', 'Newcomer test', '--json');
  assert.equal(opened.code, 0, `${opened.out}\n${opened.err}`);
  const seat = JSON.parse(opened.out);
  const next = box.run(seat.path, 'next', '--build', '--json');
  assert.equal(next.code, 0, `${next.out}\n${next.err}`);
  assert.equal(JSON.parse(next.out).item.item_lane, 'app', 'the suggested command reaches work through the normal claim');
  const idle = helpers.project('true');
  const empty = JSON.parse(idle.run(idle.repo, 'next', '--json').out).error;
  assert.equal(empty.code, 'NOTHING_FREE');
  assert.match(empty.next, /pullboard next --wait 9/u, 'a genuinely idle board retains its ordinary wait');
});

test('an agent exhausts ready own-lane work before pulling another lane [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  const web = box.json(box.runAs(box.session, box.web, 'join', 'web', '--model', 'Cross-lane test', '--json'));
  const peer = box.seat('peer-api', 'api', 'unrelated-session');
  const peerBinding = box.binding(peer.root);
  const api = box.seat('owned-api', 'api', box.session);
  const later = box.add('web', 'Later web work');
  const first = box.add('api', 'Earlier API release');
  box.milestone('first', first);
  box.milestone('later', later);

  const own = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(own.item.item_id, later, 'ready own-lane work precedes an earlier release in another lane');
  assert.equal(own.item.item_owner, web.agent);
  box.json(box.runAs(box.session, box.web, 'release', String(later), '--reason', 'BLOCKED', '--no-next', '--json'));
  box.json(box.run(box.repo, 'hold', String(later), '--reason', 'Own-lane work is intentionally blocked', '--json'));
  const next = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(next.item.item_id, first, 'an idle lane falls back to the earlier eligible foreign release');
  assert.equal(next.item.item_owner, api.agent, 'the claim belongs to the matching lane seat');
  assert.deepEqual(next.seat, { agent: api.agent, lane: 'api', path: api.root, created: false });
  assert.equal(next.review, false);
  assert.equal(next.held, false);
  assert.deepEqual(box.binding(peer.root), peerBinding, 'another session’s seat is never borrowed or rebound');
  const resumed = box.json(box.runAs(box.session, api.root, 'next', '--build', '--json'));
  assert.equal(resumed.item.item_id, first, 'next resumes the claim in the seat that holds it rather than starting a second item');
  assert.equal(resumed.held, true);
  assert.equal(resumed.seat.agent, api.agent);
  const sibling = box.runAs(box.session, box.web, 'next', '--build', '--json');
  assert.equal(sibling.code, 1, 'the idle sibling never resumes the API seat’s claim (#958)');
  box.json(box.run(box.repo, 'hold', String(later), '--off', '--json'));
  const wrongLane = box.runAs(box.session, api.root, 'claim', String(later), '--json');
  assert.equal(wrongLane.code, 1);
  assert.equal(JSON.parse(wrongLane.out).error.code, 'WRONG_LANE', 'cross-lane routing does not widen a seat’s write authority');
  assert.notEqual(web.agent, api.agent);
});

test('a seat that holds nothing is never told it holds another seat\'s claim [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  const holder = box.seat('claim-holder', 'web', box.session);
  const idle = box.seat('claim-idle', 'web', box.session);
  const bystander = box.seat('claim-bystander', 'api', box.session);
  const held = box.add('web', 'Held by the first seat');
  box.json(box.runAs(box.session, holder.root, 'claim', String(held), '--json'));
  for (const seat of [idle, bystander]) {
    const next = box.runAs(box.session, seat.root, 'next', '--build', '--json');
    const text = `${next.out}\n${next.err}`;
    assert.doesNotMatch(text, /you hold #/u, `${seat.agent} is never told it holds the claim of ${holder.agent}`);
    assert.equal(text.includes(holder.root), false, `${seat.agent} is never sent to ${holder.agent}'s checkout`);
    if (next.code === 0) assert.notEqual(JSON.parse(next.out).item.item_id, held, 'the held item is not offered again');
  }
  const own = box.json(box.runAs(box.session, holder.root, 'next', '--build', '--json'));
  assert.equal(own.item.item_id, held, 'the holding seat is still told it holds its item');
  assert.equal(own.held, true);
});

test('next names the seat to open for a lane the agent lacks [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  const web = box.seat('owned-mid-web', 'web', box.session, 'mid');
  const peer = box.seat('peer-api', 'api', 'unrelated-session');
  const peerBinding = box.binding(peer.root);
  const tooStrong = box.add('api', 'A strong-only earlier release');
  const first = box.add('api', 'Available mid API work', 'mid');
  box.milestone('strong-only', tooStrong);
  box.milestone('first-eligible', first);
  const before = box.git(box.repo, 'worktree', 'list', '--porcelain');

  const next = box.json(box.runAs(box.session, web.root, 'next', '--build', '--json'));
  assert.equal(next.item.item_id, first, 'the route still skips stronger work in an earlier milestone');
  assert.equal(next.seat.lane, 'api');
  assert.equal(next.seat.created, true);
  assert.equal(next.item.item_owner, next.seat.agent);
  assert.notEqual(next.seat.agent, peer.agent, 'a peer’s lane seat does not satisfy this session’s missing seat');
  assert.equal(existsSync(next.seat.path), true, 'next actually opens the named seat');
  assert.equal(before.includes(next.seat.path), false);
  assert.equal(box.git(next.seat.path, 'rev-parse', 'HEAD'), box.git(box.repo, 'rev-parse', 'HEAD'), 'the new seat starts on the current trunk');
  const who = box.json(box.runAs(box.session, next.seat.path, 'whoami', '--json'));
  assert.equal(who.id, next.seat.agent);
  assert.equal(who.lane, 'api');
  assert.equal(who.model, 'Cross-lane test');
  assert.equal(box.binding(next.seat.path).digest, createHash('sha256').update(JSON.stringify(['CLAUDE_CODE_SESSION_ID', box.session])).digest('hex'));
  assert.deepEqual(box.binding(peer.root), peerBinding);
  const later = box.add('web', 'Later mid web work', 'mid');
  box.milestone('later', later);
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.equal(store.getItem(board, tooStrong).item_status, 'open', 'the new mid seat never claims above its route');
    assert.equal(store.getItem(board, later).item_status, 'open');
  } finally { store.closeBoard(board); }
  assert.equal(readFileSync(join(box.repo, '.git', 'pullboard', 'board.sqlite')).includes(Buffer.from(box.session)), false, 'raw session ids stay out of shared SQLite');
});

test('next follows the rank the coordinator set inside a milestone [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  box.json(box.runAs(box.session, box.web, 'join', 'web', '--model', 'Rank test', '--json'));
  const api = box.seat('rank-owned-api', 'api', box.session);
  const peer = box.seat('rank-peer-api', 'api', 'rank-peer-session');
  const oldest = box.add('web', 'Oldest unranked strong work');
  const first = box.add('api', 'Ranked mid API work', 'mid');
  const second = box.add('web', 'Second ranked strong work');
  const later = box.add('api', 'Later release work');
  box.json(box.run(box.repo, 'milestone', 'add', 'current', '--items', `${oldest},${first},${second}`, '--json'));
  box.milestone('later', later);
  const ordered = box.runAs(box.session, box.web, 'milestone', 'order', 'current', `${first},${second}`, '--json');
  assert.equal(ordered.code, 0, `an agent can order the milestone through the real CLI\n${ordered.out}\n${ordered.err}`);
  const next = box.json(box.runAs(box.session, api.root, 'next', '--build', '--json'));
  assert.equal(next.item.item_id, first, 'explicit rank precedes route and age within the seat’s own lane');
  assert.equal(next.item.item_owner, api.agent);
  box.json(box.runAs(box.session, api.root, 'release', String(first), '--reason', 'BLOCKED', '--json'));
  box.json(box.runAs('rank-peer-session', peer.root, 'claim', String(first), '--json'));
  const free = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(free.item.item_id, second, 'an occupied higher rank leaves the next free rank available');
  const resumed = box.json(box.runAs(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(resumed.item.item_id, second, 'the agent resumes its own claim before pulling another rank');
  assert.equal(resumed.held, true);
  const beginner = box.json(box.run(box.repo, 'help', '--json'));
  assert.doesNotMatch(JSON.stringify(beginner.overview ?? beginner), /milestone order|rank the queue/iu, 'newcomer help does not gain scheduling words');
});

test('pullboard queue lists releases as breakpoints and items in pull order [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  const holder = box.seat('queue-holder', 'web', box.session);
  const oldest = box.add('web', 'Oldest unranked strong work');
  const ranked = box.add('api', 'Ranked mid API work', 'mid');
  const claimed = box.add('web', 'Claimed strong work');
  const waiting = box.add('web', 'Work after the claimed item');
  const later = box.add('api', 'Later release work');
  const loose = box.add('web', 'Work in no release');
  box.json(box.run(box.repo, 'milestone', 'add', 'current', '--items', `${oldest},${ranked},${claimed},${waiting}`, '--json'));
  box.milestone('later', later);
  box.json(box.run(box.repo, 'milestone', 'order', 'current', `${ranked}`, '--json'));
  box.json(box.run(box.repo, 'edit', String(waiting), '--after', String(claimed), '--json'));
  box.json(box.runAs(box.session, holder.root, 'claim', String(claimed), '--json'));

  const text = box.run(box.repo, 'queue');
  assert.equal(text.code, 0, text.out + text.err);
  const lines = text.out.trim().split('\n');
  const at = (pattern) => lines.findIndex((line) => pattern.test(line));
  assert.ok(at(/^current: 0\/4 landed$/u) === 0, `the first release is a breakpoint with its landed count:\n${text.out}`);
  // The claimed item unblocks the waiting one, so the self-ordered queue (#1017) puts it above the unranked one-off.
  const order = [ranked, claimed, oldest, waiting].map((id) => at(new RegExp(`^  \\d+\\. #${id} `, 'u')));
  assert.deepEqual([...order].sort((a, b) => a - b), order, `items follow next's order: rank, then the computed order:\n${text.out}`);
  assert.ok(order[0] > 0 && at(/^later: 0\/1 landed$/u) > order[3], 'the later release is its own breakpoint after the current one');
  assert.ok(at(new RegExp(`^  \\d+\\. #${later} `, 'u')) > at(/^later: /u));
  assert.ok(at(/^in no release$/u) > at(new RegExp(`#${later} `, 'u')) && at(new RegExp(`#${loose} `, 'u')) > at(/^in no release$/u));
  assert.match(lines[order[0]], new RegExp(`#${ranked} mid api open: Ranked mid API work$`, 'u'), 'each item shows its route, lane and status');
  assert.match(lines[order[1]], new RegExp(`#${claimed} strong web claimed · ${holder.agent}: `, 'u'), 'a claimed item names its holder');
  assert.match(lines[order[1] + 1], /^     unblocks 1 · effort 3 · ready and unblocks 1$/u, 'an item shows its unblock count, effort and why');
  assert.match(lines[order[3] + 2], new RegExp(`^     waits on #${claimed} \\(claimed\\)$`, 'u'), 'an item names what it waits on');

  const document = box.json(box.run(box.repo, 'queue', '--json'));
  assert.deepEqual(document.releases.map((release) => [release.name, release.landed, release.total, release.items.map((item) => item.id)]),
    [['current', 0, 4, [ranked, claimed, oldest, waiting]], ['later', 0, 1, [later]]]);
  assert.deepEqual(document.unreleased.map((item) => item.id), [loose]);
  assert.deepEqual(document.releases[0].items[1], { id: claimed, title: 'Claimed strong work', route: 'strong', lane: 'web', status: 'claimed', holder: holder.agent, waits: [],
    unblocks: 1, effort: 3, why: 'ready and unblocks 1' });
});

test('the queue names the first item each route would pull [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  const strongWork = box.add('web', 'Strong release work');
  const midWork = box.add('api', 'Mid release work', 'mid');
  const lightWork = box.add('api', 'Light release work', 'light');
  box.json(box.run(box.repo, 'milestone', 'add', 'current', '--items', `${lightWork},${midWork},${strongWork}`, '--json'));
  const document = box.json(box.run(box.repo, 'queue', '--json'));
  assert.deepEqual(document.first, { strong: strongWork, mid: midWork, light: lightWork }, 'each route gets the top item at or below it, its own tier first');
  const text = box.run(box.repo, 'queue');
  assert.match(text.out.trim().split('\n').at(-1), new RegExp(`^next now: strong → #${strongWork}, mid → #${midWork}, light → #${lightWork}$`, 'u'));
  // The queue's answer is what next actually serves each route.
  for (const [route, lane, id] of [['light', 'api', lightWork], ['mid', 'api', midWork], ['strong', 'web', strongWork]]) {
    const seat = box.seat(`queue-${route}`, lane, `queue-${route}-session`, route);
    const next = box.json(box.runAs(`queue-${route}-session`, seat.root, 'next', '--build', '--json'));
    assert.equal(next.item.item_id, id, `a ${route} agent's next is the queue's ${route} item`);
  }
  assert.match(box.run(box.repo, 'queue').out.trim().split('\n').at(-1), /^next now: strong → nothing, mid → nothing, light → nothing$/u, 'claimed work leaves the routes nothing to pull');
});

test('an unranked item follows the ranked ones [N2,B13]', (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const oldest = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Oldest ordinary item', route: 'strong' });
  const middle = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Middle ordinary item', route: 'strong' });
  const ranked = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Newest ranked item', route: 'strong' });
  store.addMilestone(board, { agentId: 'coordinator', name: 'release', items: [ranked, middle, oldest] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, oldest, 'a never-ranked board retains its old oldest-first tie-break');
  store.orderMilestoneItems(board, 'release', { agentId: 'coordinator', items: [ranked] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, ranked);
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core', priority: [oldest] }).item.item_id, ranked, 'an automatic rework tie-break does not overtake an explicit coordinator rank');
  const replica = store.openBoard(':memory:');
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(board));
  assert.equal(store.nextFor(replica, { agentId: builder, lane: 'core' }).item.item_id, ranked, 'a board snapshot retains the explicit rank');
  const ordered = [oldest, middle, ranked].map(id => store.getItem(board, id)).sort(store.buildOrder(board));
  assert.deepEqual(ordered.map(item => item.item_id), [ranked, oldest, middle], 'unranked items retain age order after explicit ranks');
  store.editMilestoneItems(board, 'release', { agentId: 'coordinator', remove: [ranked] });
  store.editMilestoneItems(board, 'release', { agentId: 'coordinator', add: [ranked] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, oldest, 'removing and readding an item does not retain a ghost rank');
});

test('milestone rank moves replay identically and preserve historical next selection [N2,B13,H16]', (t) => {
  assert.equal(MILESTONE_RANK_ENGINE, 34, 'milestone ranking retains its allocated minimum after later writer upgrades');
  for (const version of new Set([8, 24, 31, 32, 33, MILESTONE_RANK_ENGINE, ENGINE_VERSION])) {
    const source = boardFixture();
    const replica = store.openBoard(':memory:');
    const fixtures = [source, { ...source, board: replica }];
    t.after(() => fixtures.forEach(({ board }) => store.closeBoard(board)));
    for (const { board, builder } of [source]) {
      submitted(board, builder, 'oldest submitted work', 'strong', 1);
      submitted(board, builder, 'newer ranked work', 'strong', 2);
      store.addMilestone(board, { agentId: 'coordinator', name: 'release', items: [1, 2] });
    }
    importBoard(replica, exportBoard(source.board));
    const move = prepareEngineMove(fixtures[0].board, 'orderMilestoneItems', ['release', { agentId: fixtures[0].builder, items: [2, 1] }]);
    assert.equal(move.engine, ENGINE_VERSION, 'the envelope carries the current engine; milestone order starts at34');
    // Historical review receipts need a prefix before modern review activation, not a newer snapshot.
    const recorded = version < REVIEW_ROUTING_ENGINE ? { ...move, engine: MILESTONE_RANK_ENGINE } : move;
    const outcomes = fixtures.map(({ board }) => applyRelayMove(board, recorded, {
      sequence: 1, at: '2026-10-18T01:00:00Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture', agent: fixtures[0].builder },
    }));
    assert.equal(outcomes[0].error, undefined, JSON.stringify(outcomes[0]));
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.deepEqual(store.milestones(fixtures[0].board), store.milestones(fixtures[1].board));
    const reserve = prepareEngineMove(fixtures[0].board, 'reserveNextReview', [{ agentId: fixtures[0].reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' }]);
    const results = fixtures.map(({ board }) => applyEngineMove(board, { ...reserve, engine: version }, { sequence: 2, at: '2026-10-18T01:01:00Z' }));
    assert.deepEqual(results[0], results[1]);
    assert.equal(results[0].result.item.item_id, version < MILESTONE_RANK_ENGINE || version >= REVIEW_ROUTING_ENGINE ? 1 : 2, `engine${version} preserves its recorded selection`);
    assert.throws(() => applyEngineMove(fixtures[0].board, { ...move, id: 'old-order', engine: MILESTONE_RANK_ENGINE - 1 }, { sequence: 3, at: '2026-10-18T01:02:00Z' }), { code: 'RELAY_MOVE' });
    assert.equal(fixtures[0].board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key='relay_applied_sequence'").get().meta_value, '2');
  }
});

test('milestone order refuses invalid membership and unauthenticated ranking [N2,B13,H16]', (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const one = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Listed', route: 'strong' });
  const other = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Elsewhere', route: 'strong' });
  store.addMilestone(board, { agentId: 'coordinator', name: 'release', items: [one] });
  const original = JSON.stringify(store.milestones(board));
  for (const items of [[], [one, one], [other], ['missing#1']]) {
    assert.throws(() => store.orderMilestoneItems(board, 'release', { agentId: builder, items }), { code: 'MILESTONE_ITEMS' });
    assert.equal(JSON.stringify(store.milestones(board)), original);
  }
  for (const agentId of ['person', 'unknown-seat']) {
    assert.throws(() => store.orderMilestoneItems(board, 'release', { agentId, items: [one] }), { code: 'NO_AGENT' });
  }
  const forged = prepareEngineMove(board, 'orderMilestoneItems', ['release', { agentId: 'coordinator', items: [one] }]);
  const refusal = applyRelayMove(board, forged, { sequence: 1, at: '2026-10-18T01:00:00Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture', agent: builder } });
  assert.equal(refusal.error.code, 'RELAY_SENDER_MISMATCH');
  assert.equal(JSON.stringify(store.milestones(board)), original);
});

test('next in a fresh unbound checkout of a seated session claims nothing and names the seat [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  const web = box.json(box.runAs(box.session, box.web, 'join', 'web', '--model', 'Cross-lane test', '--json'));
  const item = box.add('web', 'Web work for the seated checkout');
  const fresh = join(box.dir, 'fresh-helper');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', fresh, 'main');
  const next = box.runAs(box.session, fresh, 'next', '--build', '--json');
  assert.notEqual(next.code, 0, 'an unbound checkout never claims for a seat bound elsewhere');
  const error = JSON.parse(next.out).error;
  assert.match(error.message, new RegExp(`${web.agent}.*${box.web.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'), 'it names the seat and its checkout');
  assert.match(`${error.message} ${error.next ?? ''}`, /pullboard join <lane>|pullboard join web/u, 'and the join command for this checkout');
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { assert.equal(store.getItem(board, item).item_status, 'open', 'nothing was claimed'); }
  finally { store.closeBoard(board); }
});

test('a cross-checkout claim leads with its seat and other checkouts cannot act on it [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  const web = box.json(box.runAs(box.session, box.web, 'join', 'web', '--model', 'Cross-lane test', '--json'));
  const api = box.seat('owned-api', 'api', box.session);
  const first = box.add('api', 'Earlier API release');
  box.milestone('first', first);
  const next = box.runAs(box.session, box.web, 'next', '--build');
  assert.equal(next.code, 0, next.out + next.err);
  const lines = next.out.trim().split('\n');
  assert.match(lines[0], new RegExp(`^${api.agent} .*${api.root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'), `the output leads with the holding seat and its checkout: ${lines[0]}`);
  assert.ok(lines.slice(0, 3).some((line) => line.includes(`cd '${api.root}'`) || line.includes(`cd ${api.root}`)), 'and the command to continue there');
  const later = box.add('web', 'Later web work');
  box.milestone('later', later);
  for (const args of [['check', String(first), '--yes'], ['submit', String(first)], ['release', String(first), '--reason', 'BLOCKED']]) {
    const refused = box.runAs(box.session, box.web, ...args, '--json');
    assert.notEqual(refused.code, 0, `${args[0]} from another checkout is refused`);
    const message = JSON.parse(refused.out).error.message;
    assert.ok(message.includes(api.agent) && message.includes(api.root), `${args[0]} names the holding seat and its path: ${message}`);
  }
  const again = box.runAs(box.session, box.web, 'next', '--build');
  assert.doesNotMatch(again.out, /you hold #/u, 'a checkout is never told it holds an item another seat holds');
  assert.notEqual(web.agent, api.agent);
});

test('next --verify skips an item whose builder seat shares the reviewer\'s session [N2,B13]', (t) => {
  const box = crossLaneFixture(t);
  const mine = box.seat('own-builder', 'web', box.session);
  const other = box.seat('other-builder', 'web', 'unrelated-session');
  const reviewer = box.seat('own-reviewer', 'api', box.session);
  const own = box.add('web', 'Built by the reviewer\'s own session');
  const outside = box.add('web', 'Built by another session');
  box.milestone('first', own);
  box.milestone('later', outside);
  const commit = box.git(box.repo, 'rev-parse', 'HEAD').trim(), tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}').trim();
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    for (const [id, builder] of [[own, mine.agent], [outside, other.agent]]) {
      store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze: FREEZE });
      submitFixture(board, id, { agentId: builder, commit, tree });
    }
  } finally { store.closeBoard(board); }
  const next = box.json(box.runAs(box.session, reviewer.root, 'next', '--verify', '--json'));
  assert.equal(next.item.item_id, outside, 'the review goes to an item this session did not build');
  const after = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try { assert.equal(store.getItem(after, own).item_review_by, null, 'the session\'s own item is never reserved'); }
  finally { store.closeBoard(after); }
});

test('a reserve-next move with skipIds needs engine 69 and older engines replay it as before [N2,B13]', () => {
  /** Apply one reserve-next move, stamped with `engine`, to a board holding two submissions; report the outcome. */
  const replay = (engine, withSkip) => {
    const { board, builder, reviewer } = boardFixture();
    const own = submitted(board, builder, 'own session item', 'strong', 1);
    const other = submitted(board, builder, 'other session item', 'strong', 2);
    const request = { agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any', ...(withSkip ? { skipIds: [own] } : {}) };
    const move = prepareEngineMove(board, 'reserveNextReview', [request]);
    const outcome = applyEngineMove(board, engine === undefined ? move : { ...move, engine }, { sequence: 1, at: '2026-10-21T01:00:00Z' });
    store.closeBoard(board);
    return { move, outcome, own, other };
  };
  const current = replay(undefined, true);
  assert.ok(current.move.engine >= 69, 'a skipIds move is stamped with at least engine 69');
  assert.equal(current.outcome.result.item.item_id, current.other, 'engine 69 honours skipIds');
  assert.throws(() => replay(68, true), { code: 'RELAY_MOVE' }, 'a skipIds move below engine 69 is refused, not replayed differently');
  const plain = replay(68, false);
  assert.equal(plain.outcome.result.item.item_id, plain.own, 'a move without skipIds replays at engine 68 as it always did');
});

/** The native lifecycle is seeded here; these are board-state records, not claimed gate executions. */
test('historical next never hands out work that collides with work in flight [N2,B13,N20,H16]', (t) => {
  const { board, builder, reviewer } = boardFixture();
  t.after(() => store.closeBoard(board));
  board.executionEngineVersion = CRITICAL_PATH_ENGINE - 1;
  const other = store.register(board, { lane: 'core', path: '/busy-builder', route: 'strong' });
  /** Name the actual files as a coordinator's ordinary brief does. */
  const add = (title, file) => store.addItem(board, { by: 'coordinator', lane: 'core', title,
    brief: `Files: ${file}\nTest: the native queue respects in-flight work` });
  const a = add('A is changing the shared file', 'src/x.js');
  const b = add('B would collide', 'src/x.js');
  const c = add('C can progress independently', 'src/z.js');
  store.claim(board, a, { agentId: other, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  /** Exercise the same board selector the CLI and runners use, including its explanation. */
  function avoids(stage) {
    const next = store.nextFor(board, { agentId: builder, lane: 'core' });
    assert.equal(next.item.item_id, c, `${stage}: C progresses before overlapping B`);
    assert.ok(next.reasons.some(reason => reason.includes(`#${b}`) && reason.includes(`#${a}`) && reason.includes('src/x.js')),
      `${stage}: B names the item and file it waits behind`);
  }
  avoids('claimed');
  const commit = 'a'.repeat(40);
  submitFixture(board, a, { agentId: other, commit, tree: commit });
  avoids('submitted');
  const item = store.getItem(board, a);
  store.verify(board, a, { agentId: reviewer, decision: 'ACCEPT', policy: 'any', head: commit,
    digest: item.item_frozen_digest, note: 'Synthetic accepted lifecycle record; no gate execution claimed.' });
  avoids('accepted but not landed');
  store.merged(board, a, { agentId: 'coordinator', commit: 'b'.repeat(40) });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, b,
    'landing A releases B to its original order');
});

test('an explicit colliding claim warns but remains available to the builder [N2,B13,N20]', (t) => {
  const box = crossLaneFixture(t);
  const busy = box.seat('collision-busy', 'web', 'collision-busy-session');
  const manual = box.seat('collision-manual', 'web', 'collision-manual-session');
  /** A real coordinator-created brief in the private project's permitted web lane. */
  const add = title => box.json(box.run(box.repo, 'add', 'web', title, '--specs', 'G1',
    '--brief', 'Files: web/shared.js\nTest: an explicit choice names its overlap', '--json')).item.item_id;
  const a = add('A holds the shared file');
  const b = add('B is an explicit override');
  box.json(box.runAs('collision-busy-session', busy.root, 'claim', String(a), '--json'));
  const claimed = box.runAs('collision-manual-session', manual.root, 'claim', String(b));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  assert.match(claimed.out, new RegExp(`warn.*#${a}.*web/shared\\.js`, 'iu'),
    'the normal successful claim warns about the other in-flight item and shared file');
  const renewed = box.json(box.runAs('collision-manual-session', manual.root, 'claim', String(b), '--json'));
  assert.ok(renewed.warnings?.some(warning => warning.includes(`#${a}`) && warning.includes('web/shared.js')),
    'machine-readable claims retain the same warning');
});

test('next considers other lanes but expired claims never block a file [N2,B4,N20]', (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  let at = Date.parse('2026-10-24T00:00:00Z');
  board.clock = { now: () => new Date(at) };
  const busy = store.register(board, { lane: 'api', path: '/other-lane', route: 'strong' });
  const a = store.addItem(board, { by: 'coordinator', lane: 'api', title: 'Another lane changes a shared file',
    brief: 'Files: src/shared.js' });
  const b = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Same file in this lane',
    brief: 'Files: src/shared.js' });
  const c = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Independent file',
    brief: 'Files: src/free.js' });
  store.claim(board, a, { agentId: busy, lane: 'api', leaseMs: HOUR, freeze: FREEZE });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, c,
    'a live claim in another lane still protects its named file');
  at += HOUR;
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, b,
    'the exact lease boundary releases that file without changing the stored claim');
});

test('next leaves a brief without named files in its original order [N2,N20]', (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const busy = store.register(board, { lane: 'core', path: '/busy-unspecified', route: 'strong' });
  const a = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'An in-flight file',
    brief: 'Files: src/shared.js' });
  const b = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'No declared file set',
    brief: 'Change: investigate the next useful improvement' });
  store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Later work', brief: 'Files: src/free.js' });
  store.claim(board, a, { agentId: busy, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, b,
    'missing file declarations do not invent a reservation or change selection');
});

test('the historical queue names the same noncolliding work next can serve [N2,N20,H16]', (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  board.executionEngineVersion = CRITICAL_PATH_ENGINE - 1;
  const busy = store.register(board, { lane: 'core', path: '/queue-busy', route: 'strong' });
  const a = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Already changing a file',
    brief: 'Files: src/shared.js' });
  const b = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Must wait for that file',
    brief: 'Files: src/shared.js' });
  const c = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Can proceed now',
    brief: 'Files: src/free.js' });
  store.claim(board, a, { agentId: busy, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const queue = workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: queueStore.roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility });
  assert.equal(queue.first.strong, c, 'queue does not advertise a file collision as available');
  assert.equal(queue.first.strong, store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id);
  assert.ok(queue.unreleased.find(item => item.id === b).waits.some(reason => reason.includes(`#${a}`)
    && reason.includes('src/shared.js')), 'queue retains the same actionable blocking item and file');
});

/** Real Git/SQLite and native edit/inbox commands; later lifecycle records are private fixture state, not gate executions. */
test("a claimed item whose files grow into another claimed item's files names the overlap to both holders [N2,B7,B13,N20]", t => {
  const box = crossLaneFixture(t);
  const left = box.seat('growth-left', 'web', 'growth-left-session');
  const right = box.seat('growth-right', 'web', 'growth-right-session');
  /** Create ordinary coordinator briefs in the private project's permitted lane. */
  const add = (title, file) => box.json(box.run(box.repo, 'add', 'web', title, '--specs', 'G1',
    '--brief', `Files: ${file}\nTest: growing work names its newly shared file`, '--json')).item.item_id;
  const a = add('A already holds x', 'web/x.js');
  const b = add('B initially holds only y', 'web/y.js');
  box.json(box.runAs('growth-left-session', left.root, 'claim', String(a), '--json'));
  box.json(box.runAs('growth-right-session', right.root, 'claim', String(b), '--json'));
  /** Read only this fixture's public board state and close before the next native command. */
  function onBoard(work) {
    const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
    try { return work(board); } finally { store.closeBoard(board); }
  }
  /** The coordinator's normal edit is allowed even when it creates a collision. */
  function edit(files, note = 'growing work names its newly shared file') {
    return box.json(box.run(box.repo, 'edit', String(b), '--brief', `Files: ${files}\nTest: ${note}`, '--json'));
  }
  /** One delivered notice per holder names both items and the actual new collision. */
  function noticesForBoth() {
    const messages = [
      box.json(box.runAs('growth-left-session', left.root, 'inbox', '--json')).shouts,
      box.json(box.runAs('growth-right-session', right.root, 'inbox', '--json')).shouts,
    ];
    for (const [index, messagesForHolder] of messages.entries()) {
      const notices = messagesForHolder.filter(message => message.shout_text.includes(`#${a}`)
        && message.shout_text.includes(`#${b}`) && message.shout_text.includes('web/x.js'));
      assert.equal(notices.length, 1, `${index === 0 ? 'A' : 'B'} receives exactly one new overlap notice`);
      const item = index === 0 ? a : b;
      assert.ok(onBoard(board => store.itemThread(board, item).some(event => event.kind === 'shout'
        && event.detail.shout === notices[0].shout_id)), 'the holder notice is retained on its item thread');
    }
  }
  edit('web/y.js, web/x.js');
  const grown = onBoard(board => store.getItem(board, b));
  assert.equal(grown.item_status, 'claimed', 'a warning does not revoke or reject the held edit');
  assert.match(grown.item_brief, /web\/x\.js/u, 'the real native edit stored the enlarged file list');
  noticesForBoth();
  const noticeCount = onBoard(board => store.allShouts(board).length);
  edit('web/x.js, web/y.js', 'only the prose and order changed');
  edit('web/y.js');
  assert.equal(onBoard(board => store.allShouts(board).length), noticeCount,
    'reordering existing paths, prose edits and shrinking a brief do not send duplicate notices');

  // Seed later lifecycle states with real Git object IDs. These records do not claim an executed gate or landing.
  const commit = box.git(box.repo, 'rev-parse', 'HEAD');
  const tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}');
  onBoard(board => {
    submitFixture(board, a, { agentId: left.agent, commit, tree });
    const reviewer = store.register(board, { lane: 'review', path: join(box.dir, 'growth-reviewer'), route: 'strong' });
    store.verify(board, a, { agentId: reviewer, decision: 'ACCEPT', policy: 'any', head: commit,
      digest: store.getItem(board, a).item_frozen_digest, note: 'Private lifecycle state only; no gate execution claimed.' });
    submitFixture(board, b, { agentId: right.agent, commit, tree });
  });
  edit('web/y.js, web/x.js');
  assert.equal(onBoard(board => store.getItem(board, b).item_status), 'submitted');
  noticesForBoth();
  const acceptedCount = onBoard(board => store.allShouts(board).length);
  onBoard(board => store.merged(board, a, { agentId: 'coordinator', commit }));
  edit('web/y.js');
  edit('web/y.js, web/x.js');
  assert.equal(onBoard(board => store.allShouts(board).length), acceptedCount,
    'an already landed item is no longer an in-flight collision');
});


test('line order sends a send-back home first and gives the scarcest review first [N2,B13,H16]', t => {
  const home = lineOrderFixture(t);
  const older = store.addItem(home.board, { by: 'coordinator', lane: 'core', title: 'older fresh work' });
  const returned = submitted(home.board, home.builder, 'a later send-back belongs home', 'strong', 1);
  const returnedItem = store.getItem(home.board, returned);
  store.verify(home.board, returned, { agentId: home.reviewer, decision: 'REJECT', reason: 'TEST_FAILURE',
    clause: returnedItem.item_title, note: 'Synthetic rejected lifecycle record; no gate execution claimed.', head: returnedItem.item_commit,
    digest: returnedItem.item_frozen_digest, policy: 'any', reopenFirstRefusalMinutes: 15 });
  store.addMilestone(home.board, { agentId: 'coordinator', name: 'first', items: [older] });
  assert.equal(store.nextFor(home.board, { agentId: home.builder, lane: 'core' }).item.item_id, older, 'off retains release order before rework');
  assert.equal(store.lineSettings(home.board).reviewsFirst, false, 'review-versus-build selection is a separate control');
  home.order(true);
  assert.equal(store.nextFor(home.board, { agentId: home.builder, lane: 'core' }).item.item_id, returned, 'on returns the builder to its own send-back before new release work');
  home.order(false);
  assert.equal(store.nextFor(home.board, { agentId: home.builder, lane: 'core' }).item.item_id, older, 'recorded off restores the prior order');

  const scarce = lineOrderFixture(t);
  const otherAuthor = store.register(scarce.board, { lane: 'core', path: join(scarce.root, 'author-Q'), parent: 'author-Q', session: 'author-Q-child' });
  for (let index = 0; index < 2; index++) store.register(scarce.board, { lane: 'review', path: join(scarce.root, `sibling-${index}`),
    parent: 'builder-P', session: `builder-sibling-${index}` });
  const abundant = submitted(scarce.board, otherAuthor, 'older review has several independent seats', 'strong', 2);
  const limited = submitted(scarce.board, scarce.builder, 'newer review shares its author parent with two seats', 'strong', 3);
  const prior = store.getItem(scarce.board, limited);
  store.verify(scarce.board, limited, { agentId: scarce.reviewer, decision: 'REJECT', reason: 'TEST_FAILURE',
    clause: prior.item_title, note: 'Synthetic historical-author lifecycle record; no gate execution claimed.', head: prior.item_commit, digest: prior.item_frozen_digest, policy: 'any' });
  store.claim(scarce.board, limited, { agentId: otherAuthor, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  submitFixture(scarce.board, limited, { agentId: otherAuthor, commit: '4'.repeat(40), tree: '4'.repeat(40) });
  assert.equal(store.nextFor(scarce.board, { agentId: scarce.reviewer, lane: 'review', verify: true }).item.item_id, abundant, 'off retains oldest review');
  scarce.board.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
  scarce.order(true);
  assert.equal(store.nextFor(scarce.board, { agentId: scarce.reviewer, lane: 'review', verify: true }).item.item_id, limited,
    'scarcity excludes every seat from the same parent as an author, just as the review guard does');
  const sibling = store.listAgents(scarce.board).find(agent => agent.agent_path === join(scarce.root, 'sibling-0')).agent_id;
  assert.throws(() => store.reserveReview(scarce.board, limited, { agentId: sibling, leaseMs: HOUR, policy: 'any' }),
    error => error.code === 'SELF_SESSION_VERIFY', 'the count cannot borrow eligibility from a seat refused by the real review guard');
  const snapshot = exportBoard(scarce.board);
  const replay = store.openBoard(join(scarce.root, 'replica.sqlite'));
  t.after(() => store.closeBoard(replay));
  importBoard(replay, snapshot);
  assert.equal(store.nextFor(replay, { agentId: scarce.reviewer, lane: 'review', verify: true }).item.item_id, abundant,
    'modern review age supersedes scarcity without relaxing author eligibility');
  replay.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
  assert.equal(store.nextFor(replay, { agentId: scarce.reviewer, lane: 'review', verify: true }).item.item_id, limited, 'export/import retains the recorded policy and author lineage');
  const oldMove = prepareEngineMove(replay, 'reserveNextReview', [{ agentId: scarce.reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' }]);
  const oldOutcome = applyEngineMove(replay, { ...oldMove, engine: LINE_ORDER_ENGINE - 1 }, { sequence: 1, at: '2026-10-24T00:00:00Z' });
  assert.equal(oldOutcome.result.item.item_id, abundant, 'an older recorded reserve-next retains its old ordering even with current policy records in the snapshot');

  const ranked = lineOrderFixture(t);
  const ordinary = store.addItem(ranked.board, { by: 'coordinator', lane: 'core', title: 'ranked ordinary work' });
  const dependency = store.addItem(ranked.board, { by: 'coordinator', lane: 'core', title: 'another item waits for this' });
  store.addItem(ranked.board, { by: 'coordinator', lane: 'core', title: 'blocked follower', after: [dependency] });
  const ready = store.addItem(ranked.board, { by: 'coordinator', lane: 'core', title: 'ready bar', criterion: 'a real condition is observable', check: 'true', brief: 'Files: src/ready.js\nTest: the condition is checked' });
  store.addMilestone(ranked.board, { agentId: 'coordinator', name: 'early', items: [ordinary, dependency, ready] });
  store.orderMilestoneItems(ranked.board, 'early', { agentId: 'coordinator', items: [ordinary, ready, dependency] });
  assert.equal(store.nextFor(ranked.board, { agentId: ranked.builder, lane: 'core' }).item.item_id, ordinary, 'off preserves coordinator rank');
  ranked.order(true);
  assert.equal(store.nextFor(ranked.board, { agentId: ranked.builder, lane: 'core' }).item.item_id, dependency, 'being waited on precedes ready-bar and coordinator rank');
  store.withdraw(ranked.board, dependency, { agentId: 'coordinator', reason: 'private selection control: remove the prerequisite' });
  assert.equal(store.nextFor(ranked.board, { agentId: ranked.builder, lane: 'core' }).item.item_id, ordinary, 'the signed-readiness tier is inert until its authoritative predicate lands');
  const readiness = (_board, item) => item.item_id === ready;
  const withSignedReadiness = [ordinary, ready].map(id => store.getItem(ranked.board, id))
    .sort(store.buildOrder(ranked.board, { agentId: ranked.builder, readiness }));
  assert.equal(withSignedReadiness[0].item_id, ready, 'the injected readiness predicate precedes coordinator rank without manufacturing signed records');
});

test('line capacity offers reviews before builds when reviews pile up [N2,B13,H16]', t => {
  const { board, root, builder, reviewer } = lineOrderFixture(t);
  let at = Date.parse('2026-10-24T00:00:00Z');
  board.clock = { now: () => new Date(at) };
  /** Change only the named recorded input, retaining its measured reason and window. */
  function setting(key, value) {
    store.setLineSetting(board, { agentId: 'coordinator', key, value, reason: 'seeded line-capacity window',
      window: { activeReviewers: 1, submissions: 5 } });
  }
  const waiting = Array.from({ length: 5 }, (_, index) => submitted(board, builder, `waiting review ${index}`, 'strong', index + 1));
  const build = store.addItem(board, { by: 'coordinator', lane: 'review', title: 'fresh work for the same seat' });
  assert.equal(store.reviewOffer(board, { agentId: reviewer, lane: 'review', ratio: 99 }), null,
    'off retains the old configured review ratio');
  setting('reviewsFirst', true);
  setting('wipPerReviewer', 1.5);
  const offer = store.reviewOffer(board, { agentId: reviewer, lane: 'review', ratio: 99 });
  assert.equal(offer?.item.item_id, waiting[0], 'recorded capacity replaces the legacy ratio when reviews pile up');
  assert.throws(() => store.claim(board, build, { agentId: reviewer, lane: 'review', leaseMs: HOUR, freeze: FREEZE }),
    error => error.code === 'LINE_WIP_LIMIT' && error.message.includes(`#${waiting[0]}`),
    'a new claim over the limit names the oldest eligible waiting review');
  const foreign = store.register(board, { lane: 'core', path: join(root, 'takeover'), route: 'strong', parent: 'takeover-T', session: 'takeover-child' });
  const returned = store.getItem(board, waiting[0]);
  store.verify(board, returned.item_id, { agentId: reviewer, decision: 'REJECT', reason: 'TEST_FAILURE',
    clause: returned.item_title, note: 'Synthetic lifecycle refusal; no gate execution claimed.', head: returned.item_commit,
    digest: returned.item_frozen_digest, policy: 'any', reopenFirstRefusalMinutes: 60 });
  setting('wipPerReviewer', false);
  setting('takeoverMinutes', 15);
  const historyBefore = store.events(board, { itemId: returned.item_id });
  assert.throws(() => store.claim(board, returned.item_id, { agentId: foreign, lane: 'core', leaseMs: HOUR, freeze: FREEZE }),
    error => error.code === 'REOPEN_HELD_FOR_BUILDER', 'the builder still gets the initial wait');
  at += 15 * 60_000;
  store.claim(board, returned.item_id, { agentId: foreign, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  assert.equal(store.getItem(board, returned.item_id).item_owner, foreign, 'the recorded idle wait permits a same-lane takeover');
  assert.deepEqual(store.events(board, { itemId: returned.item_id }).slice(0, historyBefore.length), historyBefore,
    'taking over appends history and never rewrites the rejected work');
  setting('reviewsFirst', false);
  const overdue = store.reviewOffer(board, { agentId: reviewer, lane: 'review', ratio: 99 });
  assert.equal(overdue?.item.item_id, waiting[1], 'over-ten-minute normal submissions override ratio even when capacity preference is off');
  assert.equal(overdue.urgent, 'age');
  board.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
  assert.equal(store.reviewOffer(board, { agentId: reviewer, lane: 'review', ratio: 99 }), null, 'historical engines restore the old ratio');
  delete board.executionEngineVersion;
});

/** Public next commands use a private Git/SQLite board; no seeded state claims a gate execution. */
test('next offers the focus milestone first and explains a claimable outside fallback [N2,B16]', t => {
  const box = crossLaneFixture(t);
  const owner = box.seat('focus-owner', 'web', box.session);
  const peer = box.seat('focus-peer', 'web', 'focus-peer-session');
  const outside = box.add('web', 'Earlier roadmap outside work');
  const focused = box.add('web', 'Named focus work');
  box.milestone('0.9.4', outside);
  box.milestone('0.9.3', focused);
  const ordinary = box.json(box.runAs(box.session, owner.root, 'next', '--build', '--json'));
  assert.equal(ordinary.item.item_id, outside, 'unset retains the existing roadmap order');
  box.json(box.runAs(box.session, owner.root, 'release', String(outside), '--reason', 'BLOCKED', '--no-next', '--json'));

  box.json(box.run(box.repo, 'settings', 'line', 'focusMilestone', '0.9.3',
    '--reason', 'Finish the named release before later work', '--window', '{"activeItems":2}', '--json'));
  const picked = box.json(box.runAs(box.session, owner.root, 'next', '--build', '--json'));
  assert.equal(picked.item.item_id, focused, 'the named focus overrides an earlier roadmap milestone');
  box.json(box.runAs(box.session, owner.root, 'release', String(focused), '--reason', 'BLOCKED', '--no-next', '--json'));
  box.json(box.runAs('focus-peer-session', peer.root, 'claim', String(focused), '--json'));
  const fallback = box.runAs(box.session, owner.root, 'next', '--build');
  assert.equal(fallback.code, 0, `${fallback.out}\n${fallback.err}`);
  const focusLines = fallback.out.split('\n').filter(line => /focus.*0\.9\.3|0\.9\.3.*focus/iu.test(line));
  assert.equal(focusLines.length, 1, 'one line explains why next leaves the named focus');
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    assert.equal(store.getItem(board, outside).item_owner, owner.agent, 'a peer-held focus does not starve claimable outside work');
    assert.equal(store.getItem(board, focused).item_owner, peer.agent, 'focus never steals another seat’s claim');
  } finally { store.closeBoard(board); }
  box.json(box.runAs(box.session, owner.root, 'release', String(outside), '--reason', 'BLOCKED', '--no-next', '--json'));
  box.json(box.runAs('focus-peer-session', peer.root, 'release', String(focused), '--reason', 'BLOCKED', '--no-next', '--json'));
  box.json(box.run(box.repo, 'settings', 'line', 'focusMilestone', 'off',
    '--reason', 'Restore ordinary roadmap selection', '--window', '{"activeItems":2}', '--json'));
  const restored = box.json(box.runAs(box.session, owner.root, 'next', '--build', '--json'));
  assert.equal(restored.item.item_id, outside, 'turning focus off restores the original order');
});

/** Review eligibility still owns held reservations; focus changes preference, not authority. */
test('historical focus reviews retain reservations and modern reviews use age [C7,N2,B16,H16]', t => {
  const { board, builder, reviewer } = boardFixture();
  board.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
  t.after(() => store.closeBoard(board));
  const outside = submitted(board, builder, 'Outside earlier roadmap review', 'strong', 1);
  const focused = submitted(board, builder, 'Named focus review', 'strong', 2);
  store.addMilestone(board, { agentId: 'coordinator', name: '0.9.4', items: [outside] });
  store.addMilestone(board, { agentId: 'coordinator', name: '0.9.3', items: [focused] });
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true, policy: 'any' }).item.item_id,
    outside, 'unset review selection keeps the roadmap order');
  setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: '0.9.3',
    reason: 'Complete the current release', window: { activeReviews: 2 } });
  delete board.executionEngineVersion;
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item.item_id, outside,
    'modern review age supersedes focus before either item is reserved');
  board.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
  const selected = store.reserveNextReview(board, { agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' });
  assert.equal(selected.item.item_id, focused, 'normal reserve-next selects the named focus');
  const peer = store.register(board, { lane: 'review', path: '/focus-review-peer', route: 'strong' });
  const fallback = store.reserveNextReview(board, { agentId: peer, lane: 'review', leaseMs: HOUR, policy: 'any' });
  assert.equal(fallback.item.item_id, outside, 'an unavailable focused review permits eligible outside work');
  assert.equal(fallback.reasons.filter(reason => /focus.*0\.9\.3|0\.9\.3.*focus/iu.test(reason)).length, 1,
    'review-only fallback carries the same one-line explanation');
  assert.equal(store.getItem(board, focused).item_verified_by, null, 'a reservation is not a verdict');
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true, policy: 'any' }).item.item_id,
    focused, 'the original reviewer retains its own reservation');
});

/** Native offers are observed against real private Git and SQLite, with synthetic lifecycle records explicitly not gate proofs. */
test('next offers the focus milestone first across review and build modes [N2,B16]', t => {
  const box = crossLaneFixture(t);
  const owner = box.seat('mixed-owner', 'web', box.session);
  const author = box.seat('mixed-author', 'api', 'mixed-author-session');
  const outside = box.add('api', 'Outside review');
  const moreOutside = [box.add('api', 'Outside review two'), box.add('api', 'Outside review three')];
  const focused = box.add('web', 'Focused build');
  box.milestone('0.9.4', outside);
  box.milestone('0.9.3', focused);
  const board = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    for (const id of [outside, ...moreOutside]) {
      store.claim(board, id, { agentId: author.agent, lane: 'api', leaseMs: HOUR, freeze: FREEZE });
      submitFixture(board, id, { agentId: author.agent, commit: box.git(box.repo, 'rev-parse', 'HEAD'),
        tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') });
    }
  } finally { store.closeBoard(board); }
  const ordinary = box.json(box.runAs(box.session, owner.root, 'next', '--json'));
  assert.equal(ordinary.review, true, 'three waiting reviews meet the unchanged offer threshold');
  assert.equal(ordinary.item.item_id, outside);
  box.json(box.run(box.repo, 'settings', 'line', 'focusMilestone', '0.9.3',
    '--reason', 'Focus across both kinds of next work', '--window', '{"activeItems":2}', '--json'));
  const picked = box.json(box.runAs(box.session, owner.root, 'next', '--json'));
  assert.equal(picked.item.item_id, focused, 'a focused build outranks an outside review');
  assert.equal(picked.review, false);
  box.json(box.runAs(box.session, owner.root, 'release', String(focused), '--reason', 'BLOCKED', '--no-next', '--json'));
  const review = box.json(box.runAs(box.session, owner.root, 'next', '--verify', '--json'));
  assert.equal(review.item.item_id, outside, 'review-only next never silently claims the focused build');
  assert.equal(review.review, true);
  box.json(box.runAs(box.session, owner.root, 'release', String(outside), '--reason', 'BLOCKED', '--note', 'Continue the private focus ordering control', '--no-next', '--json'));
  const focusedReview = box.add('api', 'Focused review before focused build');
  const updated = store.openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  try {
    store.editMilestoneItems(updated, '0.9.3', { agentId: 'coordinator', add: [focusedReview] });
    store.claim(updated, focusedReview, { agentId: author.agent, lane: 'api', leaseMs: HOUR, freeze: FREEZE });
    submitFixture(updated, focusedReview, { agentId: author.agent, commit: box.git(box.repo, 'rev-parse', 'HEAD'),
      tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') });
  } finally { store.closeBoard(updated); }
  const preferredReview = box.json(box.runAs(box.session, owner.root, 'next', '--json'));
  assert.equal(preferredReview.item.item_id, focused, 'build focus still precedes a nonurgent outside review');
  assert.equal(preferredReview.review, false);
  box.json(box.runAs(box.session, owner.root, 'release', String(focused), '--reason', 'BLOCKED', '--json'));
  const oldestReview = box.json(box.runAs(box.session, owner.root, 'next', '--verify', '--json'));
  assert.equal(oldestReview.item.item_id, moreOutside[0], 'modern review-only selection takes the oldest eligible submission before the newer focused review');
  assert.equal(oldestReview.review, true);
});

/** A newer recorded control must not alter historical selection when replaying an older move. */
test('focus milestone policy survives export while old reserve-next retains its ordering [N2,B16,H16]', t => {
  const { board, builder, reviewer } = boardFixture();
  t.after(() => store.closeBoard(board));
  const outside = submitted(board, builder, 'Old roadmap review', 'strong', 1);
  const focused = submitted(board, builder, 'New focus review', 'strong', 2);
  store.addMilestone(board, { agentId: 'coordinator', name: 'outside', items: [outside] });
  store.addMilestone(board, { agentId: 'coordinator', name: 'focus', items: [focused] });
  const change = { agentId: 'coordinator', key: 'focusMilestone', value: 'focus',
    reason: 'Recorded focus for replay', window: { activeReviews: 2 } };
  const settingMove = prepareEngineMove(board, 'setLineSetting', [change]);
  assert.throws(() => applyEngineMove(board, { ...settingMove, engine: FOCUS_MILESTONE_ENGINE - 1 },
    { sequence: 1, at: '2026-10-24T00:00:00Z' }), { code: 'RELAY_MOVE' }, 'older engines cannot claim to write the new policy');
  setLineSetting(board, change);
  const replica = store.openBoard(':memory:');
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(board));
  assert.equal(store.lineSettings(replica).focusMilestone, 'focus', 'the focus policy travels with export');
  assert.equal(store.nextFor(replica, { agentId: reviewer, lane: 'review', verify: true }).item.item_id,
    outside, 'modern review age leads despite the exported focus policy');
  replica.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
  assert.equal(store.nextFor(replica, { agentId: reviewer, lane: 'review', verify: true }).item.item_id,
    focused, 'historical review selection still reads the exported focus policy');
  delete replica.executionEngineVersion;
  const move = prepareEngineMove(replica, 'reserveNextReview', [{ agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' }]);
  const historical = applyEngineMove(replica, { ...move, engine: FOCUS_MILESTONE_ENGINE - 1 },
    { sequence: 1, at: '2026-10-24T00:00:00Z' });
  assert.equal(historical.result.item.item_id, outside, 'a historical reservation keeps its previous roadmap order');
});
