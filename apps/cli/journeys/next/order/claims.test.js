/** Next order: seat checkouts and file collisions [N2,B13,N20]. */
import * as queueStore from '../../../../../packages/store/index.js';
import { openBoard } from '../../../../lib/index.js';
import { roadmap } from '../../../../../packages/store/index.js';
import { eligibilityProblem as queueEligibility } from '../../../../../packages/verify/index.js';
import { crossLaneFixture } from '../../../tests/fixtures/e2e.js';
import { HOUR } from '../../../tests/fixtures/next/order.js';
import { FREEZE } from '../../../tests/fixtures/next/order.js';
import { boardFixture } from '../../../tests/fixtures/next/order.js';
import { submitted } from '../../../tests/fixtures/next/order.js';
import { submitFixture } from '../../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { workQueue } from '../../../../../packages/items/index.js';
import {
  applyEngineMove,
  prepareEngineMove,
} from '../../../../../packages/state/index.js';
import { CRITICAL_PATH_ENGINE } from '../../../../../packages/state/light.js';
import { join } from 'node:path';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { requireSessionIndependence } from '../../../tests/fixtures/testkit.js';

test('next in a fresh unbound checkout of a seated session claims nothing and names the seat [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  const web = box.json((await box.runAsLocal(box.session, box.web, 'join', 'web', '--model', 'fixture-model', '--json')));
  const item = box.add('web', 'Web work for the seated checkout');
  const fresh = join(box.dir, 'fresh-helper');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', fresh, 'main');
  const next = (await box.runAsLocal(box.session, fresh, 'next', '--build', '--json'));
  assert.notEqual(next.code, 0, 'an unbound checkout never claims for a seat bound elsewhere');
  const error = JSON.parse(next.out).error;
  assert.match(error.message, new RegExp(`${web.agent}.*${box.web.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}`, 'u'), 'it names the seat and its checkout');
  assert.match(`${error.message} ${error.next ?? ''}`, /pullboard join <lane>|pullboard join web/u, 'and the join command for this checkout');
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try { assert.equal(store.getItem(board, item).item_status, 'open', 'nothing was claimed'); }
  finally { store.closeBoard(board); }
});

test('a claim held in another checkout cannot be acted on from this one [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  const web = box.json((await box.runAsLocal(box.session, box.web, 'join', 'web', '--model', 'fixture-model', '--json')));
  const api = box.seat('owned-api', 'api', box.session);
  const first = box.add('api', 'Earlier API release');
  box.milestone('first', first);
  box.json((await box.runAsLocal(box.session, api.root, 'next', '--build', '--json')));
  const later = box.add('web', 'Later web work');
  box.milestone('later', later);
  for (const args of [['check', String(first), '--yes'], ['submit', String(first)], ['release', String(first), '--reason', 'BLOCKED']]) {
    const refused = (await box.runAsLocal(box.session, box.web, ...args, '--json'));
    assert.notEqual(refused.code, 0, `${args[0]} from another checkout is refused`);
    const message = JSON.parse(refused.out).error.message;
    assert.ok(message.includes(api.agent) && message.includes(api.root), `${args[0]} names the holding seat and its path: ${message}`);
  }
  const again = (await box.runAsLocal(box.session, box.web, 'next', '--build'));
  assert.doesNotMatch(again.out, /you hold #/u, 'a checkout is never told it holds an item another seat holds');
  assert.notEqual(web.agent, api.agent);
});

test('next --verify skips an item whose builder seat shares the reviewer\'s session [N2,B13]', async (t) => {
  const box = crossLaneFixture(t);
  const mine = box.seat('own-builder', 'web', box.session);
  const other = box.seat('other-builder', 'web', 'unrelated-session');
  const reviewer = box.seat('own-reviewer', 'api', box.session);
  requireSessionIndependence(reviewer.root);
  const own = box.add('web', 'Built by the reviewer\'s own session');
  const outside = box.add('web', 'Built by another session');
  box.milestone('first', own);
  box.milestone('later', outside);
  const commit = box.git(box.repo, 'rev-parse', 'HEAD').trim(), tree = box.git(box.repo, 'rev-parse', 'HEAD^{tree}').trim();
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try {
    for (const [id, builder] of [[own, mine.agent], [outside, other.agent]]) {
      store.claim(board, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze: FREEZE });
      submitFixture(board, id, { agentId: builder, commit, tree });
    }
  } finally { store.closeBoard(board); }
  const next = box.json((await box.runAsLocal(box.session, reviewer.root, 'next', '--verify', '--json')));
  assert.equal(next.item.item_id, outside, 'the review goes to an item this session did not build');
  const after = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
  try { assert.equal(store.getItem(after, own).item_review_by, null, 'the session\'s own item is never reserved'); }
  finally { store.closeBoard(after); }
});

test('a reserve-next move with skipIds needs engine 69 and older engines replay it as before [N2,B13]', () => {
  /** Apply one reserve-next move, stamped with `engine`, to a board holding two submissions; report the outcome. */
  const replay = (engine, withSkip) => {
    const { board, builder, reviewer } = boardFixture(engine ?? null);
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

test('an explicit colliding claim warns but remains available to the builder [N2,B13,N20]', async (t) => {
  const box = crossLaneFixture(t);
  const busy = box.seat('collision-busy', 'web', 'collision-busy-session');
  const manual = box.seat('collision-manual', 'web', 'collision-manual-session');
  /** A real coordinator-created brief in the private project's permitted web lane. */
  const add = title => box.json(fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1',
    '--brief', 'Files: web/shared.js\nTest: an explicit choice names its overlap', '--json')).item.item_id;
  const a = add('A holds the shared file');
  const b = add('B is an explicit override');
  box.json((await box.runAsLocal('collision-busy-session', busy.root, 'claim', String(a), '--json')));
  const claimed = (await box.runAsLocal('collision-manual-session', manual.root, 'claim', String(b)));
  assert.equal(claimed.code, 0, claimed.out + claimed.err);
  assert.match(claimed.out, new RegExp(`warn.*#${a}.*web/shared\\.js`, 'iu'),
    'the normal successful claim warns about the other in-flight item and shared file');
  const renewed = box.json((await box.runAsLocal('collision-manual-session', manual.root, 'claim', String(b), '--json')));
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
  const queue = workQueue(board, { buildOrder: queueStore.buildOrder, canTake: queueStore.canTake, listItems: queueStore.listItems, milestonePriorities: queueStore.milestonePriorities, milestones: queueStore.milestones, roadmap: roadmap, ROUTES: queueStore.ROUTES, foreignBlockers: queueStore.foreignBlockers, eligibilityProblem: queueEligibility });
  assert.equal(queue.first.strong, c, 'queue does not advertise a file collision as available');
  assert.equal(queue.first.strong, store.nextFor(board, { agentId: builder, lane: 'core' }).item.item_id);
  assert.ok(queue.unreleased.find(item => item.id === b).waits.some(reason => reason.includes(`#${a}`)
    && reason.includes('src/shared.js')), 'queue retains the same actionable blocking item and file');
});

/** Real Git/SQLite and native edit/inbox commands; later lifecycle records are private fixture state, not gate executions. */
test("a claimed item whose files grow into another claimed item's files names the overlap to both holders [N2,B7,B13,N20]", async t => {
  const box = crossLaneFixture(t);
  const left = box.seat('growth-left', 'web', 'growth-left-session');
  const right = box.seat('growth-right', 'web', 'growth-right-session');
  /** Create ordinary coordinator briefs in the private project's permitted lane. */
  const add = (title, file) => box.json(fixtureAdd(box.run, box.repo, 'web', title, '--specs', 'G1',
    '--brief', `Files: ${file}\nTest: growing work names its newly shared file`, '--json')).item.item_id;
  const a = add('A already holds x', 'web/x.js');
  const b = add('B initially holds only y', 'web/y.js');
  box.json((await box.runAsLocal('growth-left-session', left.root, 'claim', String(a), '--json')));
  box.json((await box.runAsLocal('growth-right-session', right.root, 'claim', String(b), '--json')));
  /** Read only this fixture's public board state and close before the next native command. */
  function onBoard(work) {
    const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: box.repo });
    try { return work(board); } finally { store.closeBoard(board); }
  }
  /** The coordinator's normal edit is allowed even when it creates a collision. */
  async function edit(files, note = 'growing work names its newly shared file') {
    return box.json((await box.runLocal(box.repo, 'edit', String(b), '--brief', `Files: ${files}\nTest: ${note}`, '--json')));
  }
  /** One delivered notice per holder names both items and the actual new collision. */
  async function noticesForBoth() {
    const messages = [
      box.json((await box.runAsLocal('growth-left-session', left.root, 'inbox', '--json'))).shouts,
      box.json((await box.runAsLocal('growth-right-session', right.root, 'inbox', '--json'))).shouts,
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
  await edit('web/y.js, web/x.js');
  const grown = onBoard(board => store.getItem(board, b));
  assert.equal(grown.item_status, 'claimed', 'a warning does not revoke or reject the held edit');
  assert.match(grown.item_brief, /web\/x\.js/u, 'the real native edit stored the enlarged file list');
  await noticesForBoth();
  const noticeCount = onBoard(board => store.allShouts(board).length);
  await edit('web/x.js, web/y.js', 'only the prose and order changed');
  await edit('web/y.js');
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
  await edit('web/y.js, web/x.js');
  assert.equal(onBoard(board => store.getItem(board, b).item_status), 'submitted');
  await noticesForBoth();
  const acceptedCount = onBoard(board => store.allShouts(board).length);
  onBoard(board => store.merged(board, a, { agentId: 'coordinator', commit }));
  await edit('web/y.js');
  await edit('web/y.js, web/x.js');
  assert.equal(onBoard(board => store.allShouts(board).length), acceptedCount,
    'an already landed item is no longer an in-flight collision');
});
