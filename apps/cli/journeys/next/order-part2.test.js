/** Next order: path, milestone and lane hand-off precedence [N2,B13,B16]. */
import { openBoard } from '../../../lib/index.js';
import { roadmap } from '../../../../packages/store/index.js';
import { addMilestone } from '../../../../packages/store/index.js';
import { orderMilestoneItems } from '../../../../packages/store/index.js';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';
import { HOUR } from '../../tests/fixtures/next/order.js';
import { boardFixture } from '../../tests/fixtures/next/order.js';
import { coreItems } from '../../tests/fixtures/next/order.js';
import { submitted } from '../../tests/fixtures/next/order.js';
import { REVIEW_ROUTING_ENGINE } from '../../../../packages/state/light.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { applyEngineMove } from '../../../../packages/state/index.js';
import { prepareEngineMove } from '../../../../packages/state/index.js';
import { ENGINE_VERSION } from '../../../../packages/state/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

test('a pinned eligible item is offered before an older unpinned one [B16,N2]', async (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const [older, pinned] = coreItems(board, [{ title: 'older unpinned work' }, { title: 'newer pinned work' }]);
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.8.4', items: [older, pinned] });
  orderMilestoneItems(board, '0.8.4', { agentId: 'coordinator', reason: 'Arrange fixture release', items: [pinned] });
  assert.equal(store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id, pinned,
    'the pinned item leads the milestone although an older item is also open');
});

test('a pinned item whose dependency is open is skipped [B16,N2]', async (t) => {
  const { board, builder } = boardFixture();
  t.after(() => store.closeBoard(board));
  const [, pinned, free] = coreItems(board, [{ title: 'open prerequisite elsewhere' }, { title: 'pinned but waiting', after: [0] }, { title: 'unpinned ready work' }]);
  addMilestone(board, { agentId: 'coordinator', reason: 'Arrange fixture release', name: '0.8.4', items: [pinned, free] });
  orderMilestoneItems(board, '0.8.4', { agentId: 'coordinator', reason: 'Arrange fixture release', items: [pinned] });
  const offered = store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id;
  assert.notEqual(offered, pinned, 'a pinned item still waiting on an open dependency is not offered');
  assert.equal(offered, free, 'the next eligible item in the milestone is offered instead');
});

test('recorded reserve-next moves retain their versioned ordering [B16,H16]', async (t) => {
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

test('next in the main checkout names the lane worktree to join [N2,B26]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.sandbox(), repo = join(box.dir, 'fresh-board');
  mkdirSync(repo);
  box.git(repo, 'init', '-q', '-b', 'main');
  const model = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  assert.equal((await box.runLocal(repo, 'init')).code, 0);
  if (model !== undefined) box.env.PULLBOARD_MODEL = model;
  assert.equal((await box.runLocal(repo, 'lane', 'add', 'app', '--owns', 'app/')).code, 0);
  box.git(repo, 'add', '-A');
  box.git(repo, 'commit', '-q', '-m', 'chore: set up the fresh board');
  for (const title of ['First app item', 'Second app item']) {
    const added = await fixtureAdd(box.runLocal, repo, 'app', title, '--route', 'strong',
      '--criterion', 'The app item creates its readiness marker.', '--check', 'test -f app/ready', '--json');
    assert.equal(added.code, 0, `${added.out}\n${added.err}`);
  }
  const json = (await box.runLocal(repo, 'next', '--json'));
  assert.equal(json.code, 1, json.out);
  const refusal = JSON.parse(json.out).error;
  assert.equal(refusal.code, 'NOTHING_FREE', 'the empty coordinator queue keeps its refusal code');
  assert.match(refusal.message, /2 items open in lane app/u);
  assert.equal(refusal.next, 'pullboard worktree app --model "<model name>"');
  assert.doesNotMatch(refusal.message + refusal.next, /wait|keep looking/iu);
  for (const args of [[], ['--wait', '0.01']]) {
    const text = (await box.runLocal(repo, 'next', ...args));
    assert.equal(text.code, 1);
    assert.match(text.err, /2 items open in lane app/u);
    assert.match(text.err, /pullboard worktree app --model "<model name>"/u);
    assert.doesNotMatch(text.err, /pullboard next --wait|keep looking/iu);
  }
  const opened = (await box.runLocal(repo, 'worktree', 'app', '--model', 'Newcomer test', '--json'));
  assert.equal(opened.code, 0, `${opened.out}\n${opened.err}`);
  const seat = JSON.parse(opened.out);
  const next = (await box.runLocal(seat.path, 'next', '--build', '--json'));
  assert.equal(next.code, 0, `${next.out}\n${next.err}`);
  assert.equal(JSON.parse(next.out).item.item_lane, 'app', 'the suggested command reaches work through the normal claim');
  const idle = helpers.project('true');
  const empty = JSON.parse((await idle.runLocal(idle.repo, 'next', '--build', '--json')).out).error;
  assert.equal(empty.code, 'NOTHING_FREE');
  assert.equal(empty.next, 'To keep looking: pullboard next --take', 'an idle board points to the bounded native take');
  const plain = await idle.runLocal(idle.repo, 'next', '--json');
  assert.equal(plain.code, 0, 'plain next on an idle board finishes without waiting');
  assert.equal(JSON.parse(plain.out).next, 'nothing for this seat: end your turn', 'the plain loop ends the turn instead of refusing');
});

test('an agent exhausts ready own-lane work, then names another lane\'s item without claiming it [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  const web = box.json((await box.runAsLocal(box.session, box.web, 'join', 'web', '--model', 'fixture-model', '--lock-lane', '--json')));
  const peer = box.seat('peer-api', 'api', 'unrelated-session');
  const peerBinding = box.binding(peer.root);
  const api = box.seat('owned-api', 'api', box.session);
  const later = box.add('web', 'Later web work');
  const first = box.add('api', 'Earlier API release');
  box.milestone('first', first);
  box.milestone('later', later);

  const own = box.json((await box.runAsLocal(box.session, box.web, 'next', '--build', '--json')));
  assert.equal(own.item.item_id, later, 'ready own-lane work precedes an earlier release in another lane');
  assert.equal(own.item.item_owner, web.agent);
  assert.equal(own.seat, undefined, 'the claim stays with the seat that ran next');
  box.json((await box.runAsLocal(box.session, box.web, 'release', String(later), '--reason', 'BLOCKED', '--no-next', '--json')));
  box.json((await box.runLocal(box.repo, 'hold', String(later), '--reason', 'Own-lane work is intentionally blocked', '--json')));
  const seats = async () => box.json((await box.runLocal(box.repo, 'seats', '--json'))).seats.map(row => row.seat).sort();
  const before = await seats();
  const named = (await box.runAsLocal(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(named.code, 1, 'an idle lane claims nothing in another lane');
  const message = JSON.parse(named.out).error.message;
  assert.match(message, new RegExp(`#${first}\\b.*api lane`, 'u'), `next names the other lane's item and lane: ${message}`);
  assert.equal(box.json((await box.runLocal(box.repo, 'show', String(first), '--json'))).item_status, 'open', 'the named item stays unclaimed');
  assert.deepEqual(await seats(), before, 'no seat is created or borrowed');
  assert.deepEqual(box.binding(peer.root), peerBinding, 'another session’s seat is never borrowed or rebound');
  const claimed = box.json((await box.runAsLocal(box.session, api.root, 'next', '--build', '--json')));
  assert.equal(claimed.item.item_id, first, 'the API seat claims the API item itself');
  assert.equal(claimed.item.item_owner, api.agent);
  const sibling = (await box.runAsLocal(box.session, box.web, 'next', '--build', '--json'));
  assert.equal(sibling.code, 1, 'the idle sibling never resumes the API seat’s claim (#958)');
  box.json((await box.runLocal(box.repo, 'hold', String(later), '--off', '--json')));
  const wrongLane = (await box.runAsLocal(box.session, api.root, 'claim', String(later), '--json'));
  assert.equal(wrongLane.code, 1);
  assert.equal(JSON.parse(wrongLane.out).error.code, 'WRONG_LANE', 'a seat’s write authority stays its own lane');
  assert.notEqual(web.agent, api.agent);
});

test('a seat that holds nothing is never told it holds another seat\'s claim [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  const holder = box.seat('claim-holder', 'web', box.session);
  const idle = box.seat('claim-idle', 'web', box.session);
  const bystander = box.seat('claim-bystander', 'api', box.session);
  const held = box.add('web', 'Held by the first seat');
  box.json((await box.runAsLocal(box.session, holder.root, 'claim', String(held), '--json')));
  for (const seat of [idle, bystander]) {
    const next = (await box.runAsLocal(box.session, seat.root, 'next', '--build', '--json'));
    const text = `${next.out}\n${next.err}`;
    assert.doesNotMatch(text, /you hold #/u, `${seat.agent} is never told it holds the claim of ${holder.agent}`);
    assert.equal(text.includes(holder.root), false, `${seat.agent} is never sent to ${holder.agent}'s checkout`);
    if (next.code === 0) assert.notEqual(JSON.parse(next.out).item.item_id, held, 'the held item is not offered again');
  }
  const own = box.json((await box.runAsLocal(box.session, holder.root, 'next', '--build', '--json')));
  assert.equal(own.item.item_id, held, 'the holding seat is still told it holds its item');
  assert.equal(own.held, true);
});

test('next names the lane to open for work the agent lacks, and creates no seat [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  const web = box.seat('owned-mid-web', 'web', box.session, 'mid', true);
  const peer = box.seat('peer-api', 'api', 'unrelated-session');
  const peerBinding = box.binding(peer.root);
  const tooStrong = box.add('api', 'A strong-only earlier release');
  const first = box.add('api', 'Available mid API work', 'mid');
  box.milestone('strong-only', tooStrong);
  box.milestone('first-eligible', first);
  const before = box.git(box.repo, 'worktree', 'list', '--porcelain');
  const seatsBefore = box.json((await box.runLocal(box.repo, 'seats', '--json'))).seats.map(row => row.seat).sort();

  const next = (await box.runAsLocal(box.session, web.root, 'next', '--build', '--json'));
  assert.equal(next.code, 1, next.out);
  const error = JSON.parse(next.out).error;
  assert.match(error.message, new RegExp(`#${first}\\b.*api lane`, 'u'), 'the route still skips stronger work and names the eligible item');
  assert.match(error.message, /pullboard worktree api/u, 'and the command that opens a seat for that lane');
  assert.equal(box.git(box.repo, 'worktree', 'list', '--porcelain'), before, 'next opens no worktree');
  assert.deepEqual(box.json((await box.runLocal(box.repo, 'seats', '--json'))).seats.map(row => row.seat).sort(), seatsBefore, 'and joins no seat');
  assert.deepEqual(box.binding(peer.root), peerBinding);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    assert.equal(store.getItem(board, tooStrong).item_status, 'open');
    assert.equal(store.getItem(board, first).item_status, 'open', 'the named item stays unclaimed');
  } finally { store.closeBoard(board); }
  assert.ok(web.agent);
});
