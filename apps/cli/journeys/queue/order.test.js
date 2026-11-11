import * as queueStore from '../../../../packages/store/index.js';
import {
  roadmap,
  addMilestone,
  orderMilestoneItems,
} from '../../../../packages/store/index.js';
import { eligibilityProblem as queueEligibility } from '../../../../packages/verify/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
/** Local release completion and deterministic ordering boundaries [C7,V4]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  addItem,
  buildOrder,
  claim,
  closeBoard,
  getItem,
  nextFor,
  register,
  verify,
} from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import {
  sayQueue,
  workQueue,
} from '../../../../packages/items/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { WORK_ORDER_ENGINE } from '../../../../packages/state/light.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import {
  captureReleaseQueue,
  localReleaseRank,
} from '../../../../packages/landing/index.js';
import { orderedWaiters } from '../../../../packages/queue/index.js';

test('release priority uses only local verified work, leaving external references alone [C7,V4]', () => {
  const releases = [
    { items: [{ id: 'elsewhere#1', status: 'unavailable' }, { id: 1, status: 'verified' }] },
    { items: [{ id: 2, status: 'claimed' }] },
    { items: [{ id: 3, status: 'open' }] },
  ];
  assert.deepEqual([1, 2, 3, 4].sort((a, b) => localReleaseRank(releases, a) - localReleaseRank(releases, b)), [2, 3, 1, 4],
    'an unknown external reference cannot make completed local work outrank the current release');
  const localOnly = releases.map(release => ({ items: release.items.filter(entry => typeof entry.id === 'number') }));
  assert.deepEqual([1, 2, 3, 4].map(id => localReleaseRank(releases, id)), [1, 2, 3, 4].map(id => localReleaseRank(localOnly, id)));
});

test('release ordering preserves opportunity positions and already aged arrivals [C7,V4]', () => {
  const now = Date.UTC(2026, 9, 17, 2);
  const order = { reviewsFirst: false, currentReleaseFirst: true, ageMs: 60_000 };
  /** Build one otherwise-tied waiter with a captured board rank and controlled age. */
  const row = (ticket, board, rank, waited = 0) => ({ ticket, board_key: board, release_rank: rank, release_aware: 1, since: new Date(now - waited).toISOString() });
  const line = [row(1, 'A', 2), row(2, 'B', 0), row(3, 'A', 0)];
  const ordered = orderedWaiters(line, now, order);
  assert.deepEqual(ordered.map(entry => entry.ticket), [3, 2, 1]);
  assert.deepEqual(ordered.map(entry => entry.queue_ticket ?? entry.ticket), [1, 2, 3]);
  const remaining = ordered.filter(entry => entry.ticket !== 3);
  assert.deepEqual(orderedWaiters(remaining, now, order).map(entry => entry.ticket), [2, 1], 'consumed opportunities cannot be reused');
  assert.deepEqual(orderedWaiters([row(1, 'A', 2, 61_000), row(2, 'A', 0)], now, order).map(entry => entry.ticket), [1, 2],
    'release-only admission also protects an aged unplanned run');
});

test('a run from a private clone keeps its release rank [C7,O5]', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pullboard-clone-rank-'));
  try {
    const env = { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'F', GIT_AUTHOR_EMAIL: 'f@example.invalid', GIT_COMMITTER_NAME: 'F', GIT_COMMITTER_EMAIL: 'f@example.invalid' };
    const git = (cwd, ...args) => runFixtureGit(args, { cwd, env, encoding: 'utf8', stdio: 'pipe' });
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'chore: init');
    mkdirSync(join(repo, '.git', 'pullboard'));
    const board = openBoard(join(repo, '.git', 'pullboard', 'board.sqlite'));
    const current = addItem(board, { by: 'coordinator', lane: 'web', title: 'Current' });
    const later = addItem(board, { by: 'coordinator', lane: 'web', title: 'Later' });
    addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Now', items: [current] });
    addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'Next', items: [later] });
    const expectedRanks = new Map([current, later, 999].map(id => [id, localReleaseRank(roadmap(board), id)]));
    closeBoard(board);
    const clone = join(dir, 'clone');
    git(dir, 'clone', '-q', '--shared', repo, clone);
    const fromClone = captureReleaseQueue(clone, current);
    const fromBoard = captureReleaseQueue(repo, current);
    for (const [id, rank] of expectedRanks) assert.equal(captureReleaseQueue(repo, id).rank, rank, 'lightweight capture matches the canonical roadmap rank');
    assert.ok(fromClone, 'the clone finds the board it was cloned from');
    assert.deepEqual(fromClone, fromBoard, 'the clone and the board checkout see the same board and rank');
    const now = Date.UTC(2026, 9, 17, 2);
    const order = { reviewsFirst: false, currentReleaseFirst: true, ageMs: 60_000 };
    const row = (ticket, queued) => ({ ticket, board_key: queued.board, release_rank: queued.rank, release_aware: 1, since: new Date(now).toISOString() });
    const ordinary = row(1, captureReleaseQueue(repo, later));
    const cloned = row(2, fromClone);
    assert.deepEqual(orderedWaiters([ordinary, cloned], now, order).map(entry => entry.ticket), [2, 1], 'the clone-started current-release run is admitted first');
    assert.equal(captureReleaseQueue(dir, current), undefined, 'a directory with no board keeps its queue position');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the queue ranks unblockers and quick wins first and keeps coordinator overrides [N22,B13]', (t) => {
  const board = openBoard(':memory:');
  t.after(() => closeBoard(board));
  register(board, { lane: 'coordinator', path: '/coordinator' });
  const strong = register(board, { lane: 'core', path: '/strong', route: 'strong' });
  const mid = register(board, { lane: 'core', path: '/mid', route: 'mid' });
  const light = register(board, { lane: 'core', path: '/light', route: 'light' });
  const reviewer = register(board, { lane: 'review', path: '/reviewer', route: 'strong' });
  /** Add one core item on a route, waiting on the given items. */
  const add = (title, route, after = []) => {
    const file = `src/fixture-${title.toLowerCase().replace(/\W+/gu, '-')}.js`;
    const id = addItem(board, { by: 'coordinator', lane: 'core', title, route: route === 'light' ? 'mid' : route, after,
      ...(route === 'strong' ? {} : { criterion: 'the item can be built and checked from its brief', check: 'true', brief: `Files: ${file}\nTest: the queue order` }) });
    // Light work needs a capable seat's diagnosis since 7a964958ab [C7].
    if (route === 'light') queueStore.appendFact(board, id, { agentId: strong, kind: 'diagnosis', text: `Files: ${file} Change: preserve the queue order Test case: quick wins rank before strong one-offs` });
    return id;
  };
  const strongOneOff = add('Strong one-off', 'strong');
  const lateStrong = add('Later strong one-off', 'strong');
  const lightOneOff = add('Light one-off', 'light');
  const midOneOff = add('Mid one-off', 'mid');
  const keystone = add('Keystone that 21 items wait on', 'strong');
  const midUnblocker = add('Mid unblocker', 'mid');
  const blocked = add('Blocked behind the mid unblocker', 'mid', [midUnblocker]);
  const waiting = Array.from({ length: 21 }, (_, index) => add(`Waits on the keystone ${index + 1}`, 'strong', [keystone]));
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'now', items: [strongOneOff, lateStrong, lightOneOff, midOneOff, keystone, midUnblocker, blocked] });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'later', items: waiting });
  /** The milestone's items in queue order, and the queue rows by id. */
  const queue = () => {
    const shown = workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility });
    return { ids: shown.releases[0].items.map((item) => item.id), rows: new Map(shown.releases[0].items.map((item) => [item.id, item])), shown };
  };
  /** Accept one item through the ordinary claim, submit and verify moves. */
  const land = (id, number) => {
    const builder = getItem(board, id).item_route === 'strong' ? strong : getItem(board, id).item_route === 'mid' ? mid : light;
    claim(board, id, { agentId: builder, lane: 'core', leaseMs: 3_600_000, freeze: (item) => ({ text: item.item_title, digest: `digest:${item.item_title}` }) });
    const commit = String(number).repeat(40);
    submitFixture(board, id, { agentId: builder, commit, tree: commit });
    verify(board, id, { agentId: reviewer, decision: 'ACCEPT', policy: 'any', head: commit, digest: getItem(board, id).item_frozen_digest,
      note: 'Synthetic accepted lifecycle record; no gate execution claimed.' });
  };

  let { ids, rows, shown } = queue();
  assert.deepEqual(ids, [keystone, lightOneOff, midUnblocker, midOneOff, strongOneOff, lateStrong, blocked],
    'unblockers and quick wins alternate at the top, ready work follows by score, blocked work comes last');
  assert.equal(ids[0], keystone, 'the item 21 others wait on ranks first');
  assert.ok(ids.indexOf(lightOneOff) < ids.indexOf(strongOneOff), 'a light one-off ranks above a strong one-off');
  assert.deepEqual([rows.get(keystone).unblocks, rows.get(keystone).effort], [21, 3]);
  assert.deepEqual([rows.get(lightOneOff).unblocks, rows.get(lightOneOff).effort], [0, 1]);
  assert.match(rows.get(keystone).why, /unblocks 21/u);
  assert.match(rows.get(lightOneOff).why, /quick win/u);
  assert.match(rows.get(blocked).why, /blocked/u);
  const lines = [];
  sayQueue({ say: (text) => lines.push(text) }, shown);
  assert.ok(lines.some((line) => /unblocks 21 · effort 3 · /u.test(line)), `pullboard queue prints each item's unblock count, effort and why:\n${lines.join('\n')}`);
  assert.deepEqual([strong, mid, light].map((agentId) => nextFor(board, { agentId, lane: 'core' }).item.item_id), [keystone, midUnblocker, lightOneOff],
    'next follows the computed order within each route, its own tier first');

  land(midUnblocker, 1);
  ({ ids } = queue());
  assert.ok(ids.indexOf(blocked) < ids.indexOf(strongOneOff), 'a blocked item rises above ready strong work once its blocker lands');
  assert.equal(nextFor(board, { agentId: mid, lane: 'core' }).item.item_id, midOneOff, 'the freed quick win joins the mid route in score order');

  orderMilestoneItems(board, 'now', { agentId: 'coordinator', items: [lateStrong], place: 'pin', reason: 'the release notes need it first' });
  orderMilestoneItems(board, 'now', { agentId: 'coordinator', items: [keystone], place: 'sink', reason: 'waits on a design answer' });
  ({ ids, rows } = queue());
  assert.equal(ids[0], lateStrong, 'a pinned item sits above the computed order');
  assert.equal(ids.at(-1), keystone, 'a sunk item sits below the computed order');
  assert.match(rows.get(lateStrong).why, /pinned by the coordinator: the release notes need it first/u);
  assert.match(rows.get(keystone).why, /sunk by the coordinator: waits on a design answer/u);
  assert.equal(nextFor(board, { agentId: strong, lane: 'core' }).item.item_id, lateStrong, 'next serves the pin');
  assert.throws(() => orderMilestoneItems(board, 'now', { agentId: strong, items: [strongOneOff], place: 'pin', reason: 'mine first' }), { code: 'COORDINATOR_ONLY' });
  assert.throws(() => orderMilestoneItems(board, 'now', { agentId: 'coordinator', items: [strongOneOff], place: 'pin' }), { code: 'MILESTONE_REASON' });
  assert.equal(prepareEngineMove(board, 'orderMilestoneItems', ['now', { agentId: 'coordinator', items: [strongOneOff], place: 'pin', reason: 'r' }]).engine >= WORK_ORDER_ENGINE, true);

  land(lightOneOff, 2);
  ({ ids } = queue());
  assert.deepEqual([ids[0], ids.at(-1)], [lateStrong, keystone], 'overrides survive a re-rank');
  orderMilestoneItems(board, 'now', { agentId: 'coordinator', items: [lateStrong, keystone], place: 'lift' });
  ({ ids, rows } = queue());
  assert.equal(ids[0], keystone, 'a lifted override returns to the computed order');
  assert.doesNotMatch(rows.get(lateStrong).why, /pinned/u);
  assert.deepEqual(ids, [...ids].sort((a, b) => buildOrder(board)(getItem(board, a), getItem(board, b))), 'the queue is the board\'s own build order');
});


test('ordinary milestone ordering preserves coordinator overrides until an explicit lift [N22,B13,H16]', t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  /** Read the outcome of the actual CLI and its reopened persistent board. */
  function command(cwd, ...args) {
    const result = box.run(cwd, ...args, '--json');
    assert.equal(result.code, 0, result.err + result.out);
    return JSON.parse(result.out);
  }
  for (const title of ['Pinned work', 'Sunk work', 'Ordinary work']) {
    command(box.repo, 'add', 'web', title, '--specs', 'G1');
  }
  command(box.repo, 'milestone', 'add', 'Now', '--reason', 'Arrange fixture release', '--items', '1,2,3');
  command(box.repo, 'milestone', 'pin', 'Now', '1', '--reason', 'release blocker');
  command(box.repo, 'milestone', 'sink', 'Now', '2', '--reason', 'await the design');
  const denied = box.run(box.web, 'milestone', 'order', 'Now', '2,3', '--json');
  assert.equal(JSON.parse(denied.out).error.code, 'MILESTONE_PLACED');
  const reordered = command(box.repo, 'milestone', 'order', 'Now', '2,3', '--reason', 'Set fixture priority').milestone;
  assert.ok(reordered.order.includes(1), 'an ordinary agent cannot erase a coordinator pin by omission');
  assert.ok(reordered.sunk.includes(2), 'including a sunk item cannot lift it');
  assert.deepEqual(reordered.reasons, { '1': 'release blocker', '2': 'await the design' });
  const again = command(box.repo, 'milestone', 'order', 'Now', '3,2', '--reason', 'Set fixture priority').milestone;
  assert.ok(again.order.includes(1), 'even a coordinator ordinary re-rank is not an explicit lift');
  assert.ok(again.sunk.includes(2));
  assert.deepEqual(again.reasons, reordered.reasons);
  assert.deepEqual(again.items, [1, 2, 3], 'ordering does not remove milestone membership');
  const refused = box.run(box.web, 'milestone', 'lift', 'Now', '1,2', '--json');
  assert.notEqual(refused.code, 0);
  assert.equal(JSON.parse(refused.out).error.code, 'COORDINATOR_ONLY');
  command(box.repo, 'milestone', 'lift', 'Now', '1,2');
  const lifted = command(box.repo, 'milestone', 'order', 'Now', '2,3', '--reason', 'Set fixture priority').milestone;
  assert.deepEqual(lifted.order, [2, 3], 'coordinator ordering works once overrides are explicitly lifted');
  assert.equal(lifted.sunk, undefined);
  assert.equal(lifted.reasons, undefined);
});
