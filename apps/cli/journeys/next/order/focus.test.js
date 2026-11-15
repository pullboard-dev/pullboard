/** Next order: line order, focus milestones and function overlap [N2,B16,N20]. */
import { openBoard } from '../../../../lib/index.js';
import {
  roadmap,
  addMilestone,
  editMilestoneItems,
  orderMilestoneItems,
} from '../../../../../packages/store/index.js';
import { crossLaneFixture } from '../../../tests/fixtures/e2e.js';
import { HOUR } from '../../../tests/fixtures/next/order.js';
import { FREEZE } from '../../../tests/fixtures/next/order.js';
import { boardFixture } from '../../../tests/fixtures/next/order.js';
import { submitted } from '../../../tests/fixtures/next/order.js';
import { lineOrderFixture } from '../../../tests/fixtures/next/order.js';
import { REVIEW_ROUTING_ENGINE } from '../../../../../packages/state/light.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { refreshCodeMap } from '../../../../../packages/codemap/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import { LINE_ORDER_ENGINE } from '../../../../../packages/state/light.js';
import { setLineSetting } from '../../../../../packages/store/index.js';
import { FOCUS_MILESTONE_ENGINE } from '../../../../../packages/state/light.js';
import {
  exportBoard,
  importBoard,
} from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { submitGatePlan } from '../../../../../packages/gate/index.js';
import { join } from 'node:path';

test('line order sends a send-back home first and gives the scarcest review first [N2,B13,H16]', t => {
  const home = lineOrderFixture(t);
  const older = store.addItem(home.board, { by: 'coordinator', lane: 'core', title: 'older fresh work' });
  const returned = submitted(home.board, home.builder, 'a later send-back belongs home', 'strong', 1);
  const returnedItem = store.getItem(home.board, returned);
  store.verify(home.board, returned, { agentId: home.reviewer, decision: 'REJECT', reason: 'TEST_FAILURE',
    clause: returnedItem.item_title, note: 'Synthetic rejected lifecycle record; no gate execution claimed.', head: returnedItem.item_commit,
    digest: returnedItem.item_frozen_digest, policy: 'any', reopenFirstRefusalMinutes: 15 });
  addMilestone(home.board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'first', items: [older] });
  assert.equal(store.nextFor(home.board, { agentId: home.builder, lane: 'core' }).item.item_id, returned, 'rejected work leads new release work with line order off (5ff1545383, #5765)');
  assert.equal(store.lineSettings(home.board).reviewsFirst, false, 'review-versus-build selection is a separate control');
  home.order(true);
  assert.equal(store.nextFor(home.board, { agentId: home.builder, lane: 'core' }).item.item_id, returned, 'on returns the builder to its own send-back before new release work');
  home.order(false);
  assert.equal(store.nextFor(home.board, { agentId: home.builder, lane: 'core' }).item.item_id, returned, 'recorded off still leads with rejected work (5ff1545383, #5765)');

  const scarce = lineOrderFixture(t, LINE_ORDER_ENGINE - 1);
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
  const replay = openBoard(join(scarce.root, 'replica.sqlite'));
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
  addMilestone(ranked.board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'early', items: [ordinary, dependency, ready] });
  orderMilestoneItems(ranked.board, 'early', { agentId: 'coordinator', reason: 'Arrange fixture release', items: [ordinary, ready, dependency] });
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
  assert.throws(() => store.claim(board, build, { agentId: reviewer, lane: 'review', leaseMs: HOUR, freeze: FREEZE, lineCapacity: true }),
    error => error.code === 'LINE_WIP_LIMIT' && error.message.includes(`#${waiting[0]}`),
    'a new claim over the limit names the oldest eligible waiting review');
  const foreign = store.register(board, { lane: 'core', path: join(root, 'takeover'), route: 'strong', parent: 'takeover-T', session: 'takeover-child' });
  const returned = store.getItem(board, waiting[0]);
  store.verify(board, returned.item_id, { agentId: reviewer, decision: 'ACCEPT', reason: 'CRITERION_MET',
    clause: returned.item_title, note: 'Synthetic accepted lifecycle record; no gate execution claimed.', head: returned.item_commit,
    digest: returned.item_frozen_digest, policy: 'any' });
  store.reopen(board, returned.item_id, { agentId: 'coordinator', conflict: { files: ['src/board.js'], trunk: 'b'.repeat(40) },
    note: 'Synthetic main-merge conflict lifecycle record; no merge is claimed.', reopenFirstRefusalMinutes: 60 });
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
  assert.equal(store.reviewOffer(board, { agentId: reviewer, lane: 'review', ratio: 99 }).urgent, 'age',
    'a free seat is offered an aged review at every engine, so no engine restores the old ratio for it');
  store.claim(board, build, { agentId: reviewer, lane: 'review', leaseMs: HOUR, freeze: FREEZE });
  assert.equal(store.reviewOffer(board, { agentId: reviewer, lane: 'review', ratio: 99 }), null, 'historical engines restore the old ratio for a seat that holds a build');
  delete board.executionEngineVersion;
});

/** Public next commands use a private Git/SQLite board; no seeded state claims a gate execution. */
test('next offers the focus milestone first and explains a claimable outside fallback [N2,B16]', async t => {
  const box = crossLaneFixture(t);
  const owner = box.seat('focus-owner', 'web', box.session);
  const peer = box.seat('focus-peer', 'web', 'focus-peer-session');
  const outside = box.add('web', 'Earlier roadmap outside work');
  const focused = box.add('web', 'Named focus work');
  box.milestone('0.9.4', outside);
  box.milestone('0.9.3', focused);
  const ordinary = box.json((await box.runAsLocal(box.session, owner.root, 'next', '--build', '--json')));
  assert.equal(ordinary.item.item_id, outside, 'unset retains the existing roadmap order');
  box.json((await box.runAsLocal(box.session, owner.root, 'release', String(outside), '--reason', 'OTHER', '--note', 'Fixture release', '--no-next', '--json')));

  box.json((await box.runLocal(box.repo, 'milestone', 'focus', '0.9.3', '--overflow', 'on', '--json')));
  const picked = box.json((await box.runAsLocal(box.session, owner.root, 'next', '--build', '--json')));
  assert.equal(picked.item.item_id, focused, 'the named focus overrides an earlier roadmap milestone');
  box.json((await box.runAsLocal(box.session, owner.root, 'release', String(focused), '--reason', 'OTHER', '--note', 'Fixture release', '--no-next', '--json')));
  box.json((await box.runAsLocal('focus-peer-session', peer.root, 'claim', String(focused), '--json')));
  const fallback = (await box.runAsLocal(box.session, owner.root, 'next', '--build'));
  assert.equal(fallback.code, 0, `${fallback.out}\n${fallback.err}`);
  const focusLines = fallback.out.split('\n').filter(line => /focus.*0\.9\.3|0\.9\.3.*focus/iu.test(line));
  assert.equal(focusLines.length, 1, 'one line explains why next leaves the named focus');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    assert.equal(store.getItem(board, outside).item_owner, owner.agent, 'a peer-held focus does not starve claimable outside work');
    assert.equal(store.getItem(board, focused).item_owner, peer.agent, 'focus never steals another seat’s claim');
  } finally { store.closeBoard(board); }
  box.json((await box.runAsLocal(box.session, owner.root, 'release', String(outside), '--reason', 'OTHER', '--note', 'Fixture release', '--no-next', '--json')));
  box.json((await box.runAsLocal('focus-peer-session', peer.root, 'release', String(focused), '--reason', 'OTHER', '--note', 'Fixture release', '--no-next', '--json')));
  box.json((await box.runLocal(box.repo, 'settings', 'line', 'focusMilestone', 'off',
    '--reason', 'Restore ordinary roadmap selection', '--window', '{"activeItems":2}', '--json')));
  const restored = box.json((await box.runAsLocal(box.session, owner.root, 'next', '--build', '--json')));
  assert.equal(restored.item.item_id, outside, 'turning focus off restores the original order');
});

/** Review eligibility still owns held reservations; focus changes preference, not authority. */
test('historical focus reviews retain reservations and modern reviews enforce focus [C7,N2,B16,H16]', t => {
  const { board, builder, reviewer } = boardFixture();
  board.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
  t.after(() => store.closeBoard(board));
  const outside = submitted(board, builder, 'Outside earlier roadmap review', 'strong', 1);
  const focused = submitted(board, builder, 'Named focus review', 'strong', 2);
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.9.4', items: [outside] });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.9.3', items: [focused] });
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true, policy: 'any' }).item.item_id,
    outside, 'unset review selection keeps the roadmap order');
  setLineSetting(board, { agentId: 'coordinator', key: 'focusMilestone', value: '0.9.3',
    reason: 'Complete the current release', window: { activeReviews: 2 } });
  delete board.executionEngineVersion;
  assert.equal(store.nextFor(board, { agentId: reviewer, lane: 'review', verify: true }).item.item_id, focused,
    'modern release focus precedes outside review age');
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
test('next offers the focus milestone first across review and build modes [N2,B16]', async t => {
  const box = crossLaneFixture(t);
  const owner = box.seat('mixed-owner', 'web', box.session);
  const author = box.seat('mixed-author', 'api', 'mixed-author-session');
  const outside = box.add('api', 'Outside review');
  const moreOutside = [box.add('api', 'Outside review two'), box.add('api', 'Outside review three')];
  const focused = box.add('web', 'Focused build');
  box.milestone('0.9.4', outside);
  box.milestone('0.9.3', focused);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    for (const id of [outside, ...moreOutside]) {
      store.claim(board, id, { agentId: author.agent, lane: 'api', leaseMs: HOUR, freeze: FREEZE });
      submitFixture(board, id, { agentId: author.agent, commit: box.git(box.repo, 'rev-parse', 'HEAD'),
        tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') });
    }
  } finally { store.closeBoard(board); }
  const peer = box.seat('mixed-peer', 'web', 'mixed-peer-session');
  const ordinary = box.json((await box.runAsLocal('mixed-peer-session', peer.root, 'next', '--json')));
  assert.equal(ordinary.review, true, 'three waiting reviews meet the unchanged offer threshold');
  assert.equal(ordinary.item.item_id, outside);
  box.json((await box.runLocal(box.repo, 'settings', 'line', 'focusMilestone', '0.9.3',
    '--reason', 'Focus across both kinds of next work', '--window', '{"activeItems":2}', '--json')));
  const picked = box.json((await box.runAsLocal(box.session, owner.root, 'next', '--json')));
  assert.equal(picked.item.item_id, focused, 'a focused build outranks an outside review');
  assert.equal(picked.review, false);
  box.json((await box.runAsLocal(box.session, owner.root, 'release', String(focused), '--reason', 'BLOCKED', '--no-next', '--json')));
  const review = box.json((await box.runAsLocal(box.session, owner.root, 'next', '--verify', '--json')));
  assert.equal(review.item, null, 'review-only next does not leave an enforced focus');
  const focusedReview = box.add('api', 'Focused review before focused build');
  const updated = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    editMilestoneItems(updated, '0.9.3', { agentId: 'coordinator', reason: 'Arrange fixture release', add: [focusedReview] });
    store.claim(updated, focusedReview, { agentId: author.agent, lane: 'api', leaseMs: HOUR, freeze: FREEZE });
    submitFixture(updated, focusedReview, { agentId: author.agent, commit: box.git(box.repo, 'rev-parse', 'HEAD'),
      tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') });
  } finally { store.closeBoard(updated); }
  const preferredReview = box.json((await box.runAsLocal(box.session, owner.root, 'next', '--json')));
  assert.equal(preferredReview.item.item_id, focusedReview, 'an eligible focused review is offered');
  assert.equal(preferredReview.review, true);
  const oldestReview = box.json((await box.runAsLocal(box.session, owner.root, 'next', '--verify', '--json')));
  assert.equal(oldestReview.item.item_id, focusedReview, 'review-only selection stays inside focus');
  assert.equal(oldestReview.review, true);
});

/** A newer recorded control must not alter historical selection when replaying an older move. */
test('focus milestone policy survives export while old reserve-next retains its ordering [N2,B16,H16]', t => {
  const { board, builder, reviewer } = boardFixture(FOCUS_MILESTONE_ENGINE);
  t.after(() => store.closeBoard(board));
  const outside = submitted(board, builder, 'Old roadmap review', 'strong', 1);
  const focused = submitted(board, builder, 'New focus review', 'strong', 2);
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'outside', items: [outside] });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'focus', items: [focused] });
  const change = { agentId: 'coordinator', key: 'focusMilestone', value: 'focus',
    reason: 'Recorded focus for replay', window: { activeReviews: 2 } };
  const settingMove = prepareEngineMove(board, 'setLineSetting', [change]);
  assert.throws(() => applyEngineMove(board, { ...settingMove, engine: FOCUS_MILESTONE_ENGINE - 1 },
    { sequence: 1, at: '2026-10-24T00:00:00Z' }), { code: 'RELAY_MOVE' }, 'older engines cannot claim to write the new policy');
  setLineSetting(board, change);
  const replica = openBoard(':memory:');
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(board));
  assert.equal(store.lineSettings(replica).focusMilestone, 'focus', 'the focus policy travels with export');
  assert.equal(store.nextFor(replica, { agentId: reviewer, lane: 'review', verify: true }).item.item_id,
    focused, 'modern review selection stays inside the exported focus policy');
  replica.executionEngineVersion = REVIEW_ROUTING_ENGINE - 1;
  assert.equal(store.nextFor(replica, { agentId: reviewer, lane: 'review', verify: true }).item.item_id,
    focused, 'historical review selection still reads the exported focus policy');
  delete replica.executionEngineVersion;
  const move = prepareEngineMove(replica, 'reserveNextReview', [{ agentId: reviewer, lane: 'review', leaseMs: HOUR, policy: 'any' }]);
  const historical = applyEngineMove(replica, { ...move, engine: FOCUS_MILESTONE_ENGINE - 1 },
    { sequence: 1, at: '2026-10-24T00:00:00Z' });
  assert.equal(historical.result.item.item_id, outside, 'a historical reservation keeps its previous roadmap order');
});

test('blocked release --on records and coordinator edit --after none clears the wait [B5,B10,N2]', async t => {
  const box = crossLaneFixture(t);
  box.json((await box.runAsLocal(box.session, box.web, 'join', 'web', '--model', 'fixture-model', '--json')));
  const blocker = box.add('web', 'Prerequisite');
  const work = box.add('web', 'Blocked task');
  box.json((await box.runAsLocal(box.session, box.web, 'claim', String(work), '--json')));
  box.json((await box.runAsLocal(box.session, box.web, 'release', String(work), '--reason', 'BLOCKED', '--on', String(blocker), '--no-next', '--json')));
  const shown = box.json((await box.runLocal(box.repo, 'show', String(work), '--json')));
  assert.equal(shown.item_after, String(blocker));
  const before = box.json((await box.runAsLocal(box.session, box.web, 'next', '--build', '--json')));
  assert.notEqual(before.item?.item_id, work);
  box.json((await box.runAsLocal(box.session, box.web, 'release', String(blocker), '--reason', 'OTHER', '--note', 'Return fixture prerequisite', '--no-next', '--json')));
  box.json((await box.runLocal(box.repo, 'edit', String(work), '--after', 'none', '--reason', 'Remove prerequisite', '--json')));
  box.json((await box.runAsLocal(box.session, box.web, 'claim', String(work), '--json')));
});


test('next does not hand out an item whose functions overlap work in progress [N2,N20,C7]', t => {
  const helpers = createE2eHelpers(), box = helpers.sandbox();
  const root = join(box.dir, 'function-queue');
  for (const dir of ['src', 'bin', 'test', 'packages', 'apps']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'src/shared.js'), 'export function alpha() { return 1; }\nexport function beta() { return 2; }\nexport function gamma() { return alpha(); }\n');
  writeFileSync(join(root, 'test/shared.test.js'), "import '../src/shared.js';\n");
  writeFileSync(join(root, 'bin/record-args.js'), "require('node:fs').writeFileSync('ran.json', JSON.stringify(process.argv.slice(2)));\n");
  box.git(root, 'init', '-q', '-b', 'main');
  box.git(root, 'add', 'src', 'bin', 'test');
  box.git(root, 'commit', '-qm', 'seed function map');
  refreshCodeMap(root, box.git(root, 'rev-parse', 'HEAD').trim());
  const board = openBoard(join(root, 'board.sqlite'), undefined, { gitRoot: root });
  t.after(() => { store.closeBoard(board); helpers.cleanup(); });
  store.register(board, { lane: 'coordinator', path: root });
  const busy = store.register(board, { lane: 'core', path: join(root, 'busy'), route: 'strong' });
  const builder = store.register(board, { lane: 'core', path: join(root, 'builder'), route: 'strong' });
  const add = title => store.addItem(board, { by: 'coordinator', lane: 'core', title, brief: 'Files: src/shared.js' });
  const active = add('Change alpha()');
  store.claim(board, active, { agentId: busy, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const conflict = add('Improve alpha()');
  const independent = add('Improve beta()');
  const picked = store.nextFor(board, { agentId: builder, lane: 'core' });
  assert.equal(picked.item.item_id, independent, 'the same function waits, but a distinct function in the same file may proceed');
  assert.ok(picked.reasons.some(reason => reason.includes(`#${conflict}`) && reason.includes('alpha')));
  store.claim(board, independent, { agentId: builder, lane: 'core', leaseMs: HOUR, freeze: FREEZE });
  const third = store.register(board, { lane: 'core', path: join(root, 'third'), route: 'strong' });
  const adjacent = add('Improve gamma()');
  const next = store.nextFor(board, { agentId: third, lane: 'core' });
  assert.equal(next.item.item_id, adjacent);
  assert.ok(next.reasons.some(reason => reason.includes('call-adjacent') && reason.includes('test/shared.test.js')));
  assert.deepEqual(next.crossRunTests, ['test/shared.test.js']);
  const main = box.git(root, 'rev-parse', 'HEAD').trim();
  const plan = submitGatePlan(root, { gate: 'true', affectedTests: 'node bin/record-args.js', submitGate: 'landing', submitInvariants: [], registryGuards: [] },
    { base: main, trunk: main, changed: [], check: null, crossRunTests: next.crossRunTests });
  // Process-level case: the proof command is a real shell line the gate runs, so it stays a spawned process.
  const run = spawnSync('/bin/sh', ['-c', plan.proofCommand], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.ok(JSON.parse(readFileSync(join(root, 'ran.json'), 'utf8')).includes('./test/shared.test.js'), 'the selected cross-run test actually reaches the proof command');
});
