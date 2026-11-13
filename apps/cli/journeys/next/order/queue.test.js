/** Next order: coordinator rank and the queue view [N2,B13]. */
import { openBoard } from '../../../../lib/index.js';
import {
  addMilestone,
  editMilestoneItems,
  orderMilestoneItems,
} from '../../../../../packages/store/index.js';
import { crossLaneFixture } from '../../../tests/fixtures/e2e.js';
import { HOUR } from '../../../tests/fixtures/next/order.js';
import { boardFixture } from '../../../tests/fixtures/next/order.js';
import { submitted } from '../../../tests/fixtures/next/order.js';
import { REVIEW_ROUTING_ENGINE } from '../../../../../packages/state/light.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import {
  applyEngineMove,
  applyRelayMove,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import {
  ENGINE_VERSION,
  MILESTONE_RANK_ENGINE,
} from '../../../../../packages/state/index.js';
import { QUEUE_PREEMPT_ENGINE } from '../../../../../packages/state/light.js';
import {
  exportBoard,
  importBoard,
} from '../../../../../packages/store/index.js';
import { join } from 'node:path';

function queueAnswer(output) {
  return output.replace(/\nnext: pullboard next[^\n]*\s*$/u, '');
}

test('next follows the rank the coordinator set inside a milestone [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  box.json((await box.runAsLocal(box.session, box.web, 'join', 'web', '--model', 'fixture-model', '--json')));
  const api = box.seat('rank-owned-api', 'api', box.session);
  const peer = box.seat('rank-peer-api', 'api', 'rank-peer-session');
  const oldest = box.add('web', 'Oldest unranked strong work');
  const first = box.add('api', 'Ranked mid API work', 'mid');
  const second = box.add('web', 'Second ranked strong work');
  const later = box.add('api', 'Later release work');
  box.json((await box.runLocal(box.repo, 'milestone', 'add', 'current', '--reason', 'Arrange fixture release', '--items', `${oldest},${first},${second}`, '--json')));
  box.milestone('later', later);
  const ordered = (await box.runAsLocal(box.session, box.web, 'milestone', 'order', 'current', `${first},${second}`, '--json'));
  assert.notEqual(ordered.code, 0, 'an agent cannot override automatic placement');
  assert.equal(JSON.parse(ordered.out).error.code, 'MILESTONE_PLACED');
  box.json((await box.runLocal(box.repo, 'milestone', 'order', 'current', `${first},${second}`, '--reason', 'Set fixture priority', '--json')));
  const next = box.json((await box.runAsLocal(box.session, api.root, 'next', '--build', '--json')));
  assert.equal(next.item.item_id, first, 'explicit rank precedes route and age within the seat’s own lane');
  assert.equal(next.item.item_owner, api.agent);
  box.json((await box.runAsLocal(box.session, api.root, 'release', String(first), '--reason', 'BLOCKED', '--json')));
  box.json((await box.runAsLocal('rank-peer-session', peer.root, 'claim', String(first), '--json')));
  const free = box.json((await box.runAsLocal(box.session, box.web, 'next', '--build', '--json')));
  assert.equal(free.item.item_id, second, 'an occupied higher rank leaves the next free rank available');
  const resumed = box.json((await box.runAsLocal(box.session, box.web, 'next', '--build', '--json')));
  assert.equal(resumed.item.item_id, second, 'the agent resumes its own claim before pulling another rank');
  assert.equal(resumed.held, true);
  const beginner = box.json((await box.runLocal(box.repo, 'help', '--json')));
  assert.doesNotMatch(JSON.stringify(beginner.overview ?? beginner), /milestone order|rank the queue/iu, 'newcomer help does not gain scheduling words');
});

test('clause 1: pullboard queue lists releases as breakpoints and items in pull order [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  const holder = box.seat('queue-holder', 'web', box.session);
  const oldest = box.add('web', 'Oldest unranked strong work');
  const ranked = box.add('api', 'Ranked mid API work', 'mid');
  const claimed = box.add('web', 'Claimed strong work');
  const waiting = box.add('web', 'Work after the claimed item');
  const later = box.add('api', 'Later release work');
  const loose = box.add('web', 'Work in no release');
  box.json((await box.runLocal(box.repo, 'milestone', 'add', 'current', '--reason', 'Arrange fixture release', '--items', `${oldest},${ranked},${claimed},${waiting}`, '--json')));
  box.milestone('later', later);
  box.json((await box.runLocal(box.repo, 'milestone', 'order', 'current', `${ranked}`, '--reason', 'Set fixture priority', '--json')));
  box.json((await box.runLocal(box.repo, 'edit', String(waiting), '--after', String(claimed), '--json')));
  box.json((await box.runAsLocal(box.session, holder.root, 'claim', String(claimed), '--json')));

  const text = (await box.runLocal(box.repo, 'queue'));
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

  const document = box.json((await box.runLocal(box.repo, 'queue', '--json')));
  assert.deepEqual(document.releases.map((release) => [release.name, release.landed, release.total, release.items.map((item) => item.id)]),
    [['current', 0, 4, [ranked, claimed, oldest, waiting]], ['later', 0, 1, [later]]]);
  assert.deepEqual(document.unreleased.map((item) => item.id), [loose]);
  assert.deepEqual(document.releases[0].items[1], { id: claimed, title: 'Claimed strong work', route: 'strong', lane: 'web', status: 'claimed', holder: holder.agent, waits: [],
    unblocks: 1, effort: 3, why: 'ready and unblocks 1' });
});

test('the queue names the first item each route would pull [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  const strongWork = box.add('web', 'Strong release work');
  const midWork = box.add('api', 'Mid release work', 'mid');
  const lightWork = box.add('api', 'Light release work', 'mid');
  box.json((await box.runLocal(box.repo, 'fact', String(lightWork), 'diagnosis',
    'Files: api/light.js\nChange: keep the light item eligible for its route\nTest case: a light seat selects this item from the release queue', '--json')));
  box.json((await box.runLocal(box.repo, 'edit', String(lightWork), '--route', 'light', '--json')));
  box.json((await box.runLocal(box.repo, 'milestone', 'add', 'current', '--reason', 'Arrange fixture release', '--items', `${lightWork},${midWork},${strongWork}`, '--json')));
  const document = box.json((await box.runLocal(box.repo, 'queue', '--json')));
  assert.deepEqual(document.first, { strong: strongWork, mid: midWork, light: lightWork }, 'each route gets the top item at or below it, its own tier first');
  const text = (await box.runLocal(box.repo, 'queue'));
  text.out = queueAnswer(text.out);
  assert.match(text.out.trim().split('\n').at(-1), new RegExp(`^next now: strong → #${strongWork}, mid → #${midWork}, light → #${lightWork}$`, 'u'));
  // The queue's answer is what next actually serves each route.
  for (const [route, lane, id] of [['light', 'api', lightWork], ['mid', 'api', midWork], ['strong', 'web', strongWork]]) {
    const seat = box.seat(`queue-${route}`, lane, `queue-${route}-session`, route);
    const next = box.json((await box.runAsLocal(`queue-${route}-session`, seat.root, 'next', '--build', '--json')));
    assert.equal(next.item.item_id, id, `a ${route} agent's next is the queue's ${route} item`);
  }
  const queueWithoutHint = queueAnswer((await box.runLocal(box.repo, 'queue')).out);
  assert.match(queueWithoutHint.trim().split('\n').at(-1), /^next now: strong → nothing, mid → nothing, light → nothing$/u, 'claimed work leaves the routes nothing to pull');
});

test('an unranked item follows the ranked ones [N2,B13]', (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const oldest = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Oldest ordinary item', route: 'strong' });
  const middle = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Middle ordinary item', route: 'strong' });
  const ranked = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Newest ranked item', route: 'strong' });
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'release', items: [ranked, middle, oldest] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, oldest, 'a never-ranked board retains its old oldest-first tie-break');
  orderMilestoneItems(board, 'release', { agentId: 'coordinator', reason: 'Arrange fixture release', items: [ranked] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, ranked);
  // From QUEUE_PREEMPT_ENGINE main-red evidence is an emergency that leads even an explicit rank (#1442), so the
  // rework tie-break rule is proved on the engine below it and the emergency lead on the current one.
  const pinnedEngine = board.executionEngineVersion;
  board.executionEngineVersion = QUEUE_PREEMPT_ENGINE - 1;
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core', priority: [oldest] }).item.item_id, ranked, 'an automatic rework tie-break does not overtake an explicit coordinator rank');
  if (pinnedEngine === undefined) delete board.executionEngineVersion; else board.executionEngineVersion = pinnedEngine;
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core', priority: [oldest] }).item.item_id, oldest, 'main-red evidence leads an explicit rank once emergencies preempt');
  const replica = openBoard(':memory:');
  t.after(() => store.closeBoard(replica));
  importBoard(replica, exportBoard(board));
  assert.equal(store.nextFor(replica, { agentId: builder, lane: 'core' }).item.item_id, ranked, 'a board snapshot retains the explicit rank');
  const ordered = [oldest, middle, ranked].map(id => store.getItem(board, id)).sort(store.buildOrder(board));
  assert.deepEqual(ordered.map(item => item.item_id), [ranked, oldest, middle], 'unranked items retain age order after explicit ranks');
  editMilestoneItems(board, 'release', { agentId: 'coordinator', remove: [ranked] });
  editMilestoneItems(board, 'release', { agentId: 'coordinator', reason: 'Arrange fixture release', add: [ranked] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, oldest, 'removing and readding an item does not retain a ghost rank');
});

test('milestone rank moves replay identically and preserve historical next selection [N2,B13,H16]', (t) => {
  assert.equal(MILESTONE_RANK_ENGINE, 34, 'milestone ranking retains its allocated minimum after later writer upgrades');
  for (const version of new Set([8, 24, 31, 32, 33, MILESTONE_RANK_ENGINE, ENGINE_VERSION])) {
    const source = boardFixture(version);
    const replica = openBoard(':memory:');
    const fixtures = [source, { ...source, board: replica }];
    t.after(() => fixtures.forEach(({ board }) => store.closeBoard(board)));
    for (const { board, builder } of [source]) {
      submitted(board, builder, 'oldest submitted work', 'strong', 1);
      submitted(board, builder, 'newer ranked work', 'strong', 2);
      addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'release', items: [1, 2] });
    }
    importBoard(replica, exportBoard(source.board));
    delete source.board.executionEngineVersion;
    const move = prepareEngineMove(fixtures[0].board, 'orderMilestoneItems', ['release', { agentId: 'coordinator', items: [2, 1], reason: 'Arrange fixture order' }]);
    assert.equal(move.engine, ENGINE_VERSION, 'the envelope carries the current engine; milestone order starts at34');
    // Historical review receipts need a prefix before modern review activation, not a newer snapshot.
    const recorded = version < REVIEW_ROUTING_ENGINE
      ? { ...move, engine: MILESTONE_RANK_ENGINE, args: ['release', { agentId: 'coordinator', items: [2, 1] }] }
      : move;
    const outcomes = fixtures.map(({ board }) => applyRelayMove(board, recorded, {
      sequence: 1, at: '2026-10-18T01:00:00Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture', agent: 'coordinator' },
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
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: 'release', items: [one] });
  const original = JSON.stringify(store.milestones(board));
  for (const items of [[], [one, one], [other], ['missing#1']]) {
    assert.throws(() => orderMilestoneItems(board, 'release', { agentId: 'coordinator', items, reason: 'Validate fixture membership' }), { code: 'MILESTONE_ITEMS' });
    assert.equal(JSON.stringify(store.milestones(board)), original);
  }
  for (const agentId of ['person', 'unknown-seat']) {
    assert.throws(() => orderMilestoneItems(board, 'release', { agentId, items: [one] }), { code: 'MILESTONE_PLACED' });
  }
  const forged = prepareEngineMove(board, 'orderMilestoneItems', ['release', { agentId: 'coordinator', items: [one] }]);
  const refusal = applyRelayMove(board, forged, { sequence: 1, at: '2026-10-18T01:00:00Z', kind: 'move', sender: { kind: 'agent', userId: 'fixture', agent: builder } });
  assert.equal(refusal.error.code, 'RELAY_SENDER_MISMATCH');
  assert.equal(JSON.stringify(store.milestones(board)), original);
});
