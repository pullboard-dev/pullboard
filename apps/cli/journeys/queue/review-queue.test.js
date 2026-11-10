/** @pullboard-test-loads packages/store/src/io/board.js packages/state/src/io/engine.js src/exchange.js */
import { agentSessionDigest } from '../../../../packages/person/index.js';
/** A review offer accounts for backlog, live reservations and reviewer eligibility [Q1,V15]. */
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { unpackRelease } from '../../tests/fixtures/release/archive.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { nextReview } from '../../../../packages/verify/index.js';
import { mainRedReviewItems } from '../../../../packages/landing/index.js';
import { Refused } from '../../../../packages/kernel/light.js';
import { AGENT_GRANT_ENGINE } from '../../../../packages/state/light.js';
import {
  appliedSequence,
  applyEngineMove,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import {
  exportBoard,
  importBoard,
} from '../../../../packages/store/index.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import {
  fixtureJoin,
  joinFixtureSeat,
} from '../../tests/fixtures/testkit.js';

const HOUR = 60 * 60 * 1000;
const REVIEW_LEASE = 1_000;

/** Create an in-memory board with deterministic agent routes, families and a controllable clock. */
function fixture(t, { reviewerFamilies = ['Alpha', 'Beta'] } = {}) {
  let milliseconds = Date.parse('2026-10-08T12:00:00.000Z');
  const clock = {
    now: () => new Date(milliseconds),
    advance: (duration) => { milliseconds += duration; },
  };
  const board = openBoard(':memory:', clock);
  t.after(() => store.closeBoard(board));
  const agents = {
    coordinator: store.register(board, { lane: 'coordinator', path: '/fixture/main', family: 'Fixture Coordinator Vendor' }),
    alphaBuilder: store.register(board, { lane: 'web', path: '/fixture/web-alpha', route: 'strong', family: 'Alpha' }),
    betaBuilder: store.register(board, { lane: 'web', path: '/fixture/web-beta', route: 'strong', family: 'Beta' }),
    lightBuilder: store.register(board, { lane: 'web', path: '/fixture/web-light', route: 'light', family: 'Gamma' }),
    alphaReviewer: store.register(board, { lane: 'review', path: '/fixture/review-alpha', route: 'strong', family: reviewerFamilies[0] }),
    betaReviewer: store.register(board, { lane: 'review', path: '/fixture/review-beta', route: 'strong', family: reviewerFamilies[1] }),
    lightReviewer: store.register(board, { lane: 'review', path: '/fixture/review-light', route: 'light', family: 'Gamma' }),
  };
  return { board, clock, agents };
}

/** Freeze the fixture title and digest, as a CLI claim callback does for a submitted item. */
function freeze(item) {
  const text = JSON.stringify({ title: item.item_title });
  return { text, digest: createHash('sha256').update(text).digest('hex') };
}

/** Create and claim a submitted item with deterministic Git pins and a real board event history. */
function submitted(board, { builder, lane = 'web', route = 'strong', title }) {
  const id = store.addItem(board, { by: 'coordinator', lane, title, route, criterion: `Complete ${title}.` });
  store.claim(board, id, { agentId: builder, lane, leaseMs: HOUR, freeze });
  const commit = createHash('sha1').update(`commit:${title}`).digest('hex');
  const tree = createHash('sha1').update(`tree:${title}`).digest('hex');
  submitFixture(board, id, { agentId: builder, commit, tree });
  return id;
}

/** Make one live review reservation through the same store operation used by the CLI. */
function reserve(board, item, agentId, leaseMs = REVIEW_LEASE) {
  return store.reserveReview(board, item, { agentId, leaseMs, policy: 'any' });
}

test('[Q1,V15] clause 1: an empty queue is zeroed and exactly three waiting items produce an offer over build work', (t) => {
  const { board, agents } = fixture(t);
  assert.deepEqual(store.reviewQueue(board), {
    pending: 0, reviewing: 0, reserved: 0, oldestSubmittedAt: null, ageMs: 0,
  });

  const open = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'Available build' });
  const ids = [
    submitted(board, { builder: agents.alphaBuilder, title: 'Waiting one' }),
    submitted(board, { builder: agents.betaBuilder, title: 'Waiting two' }),
    submitted(board, { builder: agents.alphaBuilder, title: 'Waiting three' }),
  ];
  const offer = store.reviewOffer(board, { agentId: agents.betaReviewer, lane: 'review', policy: 'any', ratio: 3 });
  assert.ok(offer, 'the queue meets the three-to-one threshold even while build work is open');
  assert.ok(ids.includes(offer.item.item_id));
  assert.deepEqual(offer.queue, store.reviewQueue(board));
  assert.equal(offer.queue.pending, 3);
  assert.equal(offer.queue.reviewing, 0);
  assert.equal(offer.ratio, 3);
  assert.equal(store.getItem(board, open).item_status, 'open', 'offering review does not claim or close build work');
});

test('[Q1,V15] a short queue and a reviewer who built every submitted item receive no offer', (t) => {
  const { board, agents } = fixture(t);
  submitted(board, { builder: agents.alphaBuilder, title: 'First waiting item' });
  submitted(board, { builder: agents.betaBuilder, title: 'Second waiting item' });
  assert.equal(store.reviewOffer(board, { agentId: agents.alphaReviewer, lane: 'review', policy: 'any', ratio: 3 }), null,
    'two pending reviews are below ratio three with no active reviewers');

  const own = fixture(t);
  const onlyMine = submitted(own.board, { builder: own.agents.betaReviewer, lane: 'review', title: 'Reviewer own item' });
  const ownOffer = store.reviewOffer(own.board, { agentId: own.agents.betaReviewer, lane: 'review', policy: 'any', ratio: 1 });
  assert.equal(ownOffer, null, 'meeting the threshold cannot make a reviewer review its own submission');
  assert.equal(store.getItem(own.board, onlyMine).item_built_by, own.agents.betaReviewer);
});

test('[Q1,V15] live reservations count distinct agents; renewal leaves submitted age anchored to submit events', (t) => {
  const { board, clock, agents } = fixture(t, { reviewerFamilies: ['Fixture Counter Reviewer One', 'Fixture Counter Reviewer Two'] });
  const first = submitted(board, { builder: agents.alphaBuilder, title: 'Oldest item' });
  const firstSubmittedAt = store.events(board, { itemId: first }).filter((event) => event.event_kind === 'submit').at(-1).event_at;
  clock.advance(10_000);
  const second = submitted(board, { builder: agents.betaBuilder, title: 'Second item' });
  clock.advance(10_000);
  const third = submitted(board, { builder: agents.alphaBuilder, title: 'Third item' });

  reserve(board, first, agents.alphaReviewer);
  reserve(board, second, agents.alphaReviewer);
  clock.advance(250);
  reserve(board, first, agents.alphaReviewer);
  reserve(board, third, agents.alphaReviewer);
  let queue = store.reviewQueue(board);
  assert.deepEqual([queue.pending, queue.reviewing, queue.reserved], [3, 1, 3]);
  assert.equal(queue.oldestSubmittedAt, firstSubmittedAt);
  assert.equal(queue.ageMs, clock.now().getTime() - Date.parse(firstSubmittedAt), 'renewing a reservation never resets submit age');

  clock.advance(REVIEW_LEASE + 1);
  queue = store.reviewQueue(board);
  assert.deepEqual([queue.pending, queue.reviewing, queue.reserved], [3, 0, 0], 'expired reviewers and item holds leave the live queue counts');
  assert.equal(queue.oldestSubmittedAt, firstSubmittedAt);
  assert.equal(queue.ageMs, clock.now().getTime() - Date.parse(firstSubmittedAt));

  reserve(board, second, agents.betaReviewer);
  queue = store.reviewQueue(board);
  assert.deepEqual([queue.reviewing, queue.reserved], [1, 1], 'a new live reservation counts its distinct reviewer and held item');
  assert.equal(queue.oldestSubmittedAt, firstSubmittedAt, 'the new reservation still does not reset submit age');
});

test('[Q1,V15,O2,B13] policy, family and route rules still decide which reviewer can take an offer', (t) => {
  const { board, agents } = fixture(t);
  submitted(board, { builder: agents.alphaBuilder, title: 'Strong Alpha item', route: 'strong' });

  assert.equal(store.reviewOffer(board, {
    agentId: agents.betaReviewer, lane: 'review', policy: 'coordinator', ratio: 1,
  }), null, 'coordinator policy excludes lane reviewers');
  const coordinatorOffer = store.reviewOffer(board, {
    agentId: agents.coordinator, lane: 'coordinator', policy: 'coordinator', ratio: 1,
  });
  assert.ok(coordinatorOffer, 'the coordinator can take its policy-required review');

  assert.equal(store.reviewOffer(board, {
    agentId: agents.alphaReviewer, lane: 'review', policy: 'any', familyPolicy: 'require', ratio: 1,
  }), null, 'family=require excludes the builder family');
  const otherFamily = store.reviewOffer(board, {
    agentId: agents.betaReviewer, lane: 'review', policy: 'any', familyPolicy: 'require', ratio: 1,
  });
  assert.ok(otherFamily, 'a different declared family can review');

  assert.equal(store.reviewOffer(board, {
    agentId: agents.lightReviewer, lane: 'review', policy: 'any', ratio: 1,
  }), null, 'a light reviewer cannot take a strong item');
});

/**
 * A real board where web-1 submits #1, then main changes the same file (#807). A second seat in the api lane
 * reviews, so the builder never verifies its own work. Returns the box and helpers.
 */
function staleHeadFixture(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  /** Demand real command success and its versioned result. */
  const json = (result) => { assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  /** Add, claim, build and submit one web item from a web seat's worktree. */
  const build = (title, path, text, seat = box.web) => {
    const id = json(fixtureAdd(box.run, box.repo, 'web', title, '--criterion', `${path} exists`, '--json')).item.item_id;
    json(box.run(seat, 'claim', String(id), '--json'));
    mkdirSync(join(seat, 'web'), { recursive: true });
    writeFileSync(join(seat, path), text);
    box.git(seat, 'add', path);
    box.git(seat, 'commit', '-q', '-m', `feat(web): ${title.toLowerCase()} [G1]`);
    json(box.run(seat, 'submit', String(id), '--json'));
    return id;
  };
  const conflicted = build('Show the list', 'web/list.html', '<ul>from the branch</ul>\n');
  // The trunk moves: the same file lands on main with other lines.
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/list.html'), '<ol>from main</ol>\n');
  box.git(box.repo, 'add', 'web/list.html');
  box.git(box.repo, 'commit', '-q', '-m', 'feat(web): main lands its own list [G1]');
  const reviewer = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', reviewer, '-b', 'api/review');
  // The reviewer joins on the strong route the fixture items are filed for, so it may review a strong head.
  json(joinFixtureSeat(box, reviewer, 'api'));
  return { box, json, build, conflicted, reviewer };
}

test('a submitted head that no longer merges is returned to its builder [C7,V4]', (t) => {
  const { box, json, conflicted, reviewer } = staleHeadFixture(t);
  assert.equal(json(box.run(box.repo, 'show', String(conflicted), '--json')).item_status, 'submitted', 'the head waits for review before the trunk check');
  const next = box.run(reviewer, 'next', '--verify', '--json');
  assert.match(next.err, new RegExp(`returned #${conflicted} to its builder unreviewed: it no longer merges onto the trunk \\(web/list\\.html\\)`, 'u'), next.out + next.err);
  const item = json(box.run(box.repo, 'show', String(conflicted), '--json'));
  assert.equal(item.item_status, 'open', 'the head that no longer merges goes back, unreviewed');
  assert.equal(item.item_review_by, null, 'no reviewer holds it');
  assert.equal(item.item_verdict, null, 'returning it is not a reject');
  const reopen = item.thread.findLast((entry) => entry.type === 'move' && entry.kind === 'reopen');
  assert.ok(reopen, 'the return is a recorded reopen');
  const inbox = box.run(box.web, 'inbox').out;
  assert.match(inbox, new RegExp(`#${conflicted} went back to you unreviewed: .* no longer merges onto the trunk at [0-9a-f]{12} \\(web/list\\.html\\)\\. Claim it, merge main, resolve that file and submit again: pullboard claim ${conflicted}`, 'u'),
    'the builder is told the conflicting file and the one step back');
  json(box.run(box.web, 'claim', String(conflicted), '--json'));
});

test('next --verify skips a head that does not merge [C7,V4]', (t) => {
  const { box, json, build, conflicted, reviewer } = staleHeadFixture(t);
  // A second web seat on a fresh branch from main builds work that merges cleanly.
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two', 'main');
  json(joinFixtureSeat(box, second, 'web'));
  const clean = build('Show the footer', 'web/footer.html', '<footer>clean</footer>\n', second);
  const next = json(box.run(reviewer, 'next', '--verify', '--json'));
  assert.equal(next.item.item_id, clean, 'the reviewer gets the head that merges, though the conflicting one is older');
  assert.equal(json(box.run(box.repo, 'show', String(conflicted), '--json')).item_status, 'open');
  assert.equal(json(box.run(box.repo, 'show', String(clean), '--json')).item_review_by !== null, true, 'the clean head is reserved for review');
});

/** Clause 1 of #2745: the review queue skips a submitted head that no longer merges and hands the reviewer the clean one. */
test('clause 1: next --verify skips a head that does not merge and returns it unreviewed [C7,V4]', (t) => {
  const { box, json, build, conflicted, reviewer } = staleHeadFixture(t);
  const second = join(box.dir, 'web-2');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/two', 'main');
  json(joinFixtureSeat(box, second, 'web'));
  const clean = build('Show the footer', 'web/footer.html', '<footer>clean</footer>\n', second);
  const next = json(box.run(reviewer, 'next', '--verify', '--json'));
  assert.equal(next.item.item_id, clean, 'the reviewer gets the head that merges, though the conflicting one is older');
  const returned = json(box.run(box.repo, 'show', String(conflicted), '--json'));
  assert.equal(returned.item_status, 'open', 'the head that does not merge goes back to its builder');
  assert.equal(returned.item_review_by, null, 'no reviewer holds the head that does not merge');
  assert.equal(returned.item_verdict, null, 'returning it is not a reject');
  assert.notEqual(json(box.run(box.repo, 'show', String(clean), '--json')).item_review_by, null, 'the clean head is reserved for review');
});

/** Drive nextReview over a board with one submitted head that conflicts, recording each ordered operation. */
async function refusedReturn(t, reopen) {
  const { board, agents } = fixture(t);
  const id = submitted(board, { builder: agents.alphaBuilder, title: 'Conflicting head' });
  const operations = [];
  const ordered = async (operation, args) => {
    operations.push(operation);
    if (operation === 'reopen') return await reopen(board, id);
    return store.reserveNextReview(board, args[0]);
  };
  const ctx = { info: { root: '/fixture' }, io: { err: () => {} }, config: { reviewLeaseMs: REVIEW_LEASE, verify: { policy: 'any' } } };
  const me = { id: agents.betaReviewer, lane: 'review' };
  const trunkMerge = () => ({ commit: 'a'.repeat(40), files: ['web/list.html'] });
  const run = () => nextReview(ctx, board, me, {}, { ordered, idArg: Number, trunkMerge, listItems: store.listItems, itemById: store.itemById, getItem: store.getItem, mainRedReviewItems, agentSessionDigest });
  return { board, id, operations, run };
}

test('a refused return of a conflicting head is never followed by reserving it [C7,V4]', async (t) => {
  const { board, id, operations, run } = await refusedReturn(t, () => { throw new Refused('RELAY_BUSY', 'the relay is busy'); });
  await assert.rejects(run, (error) => error.code === 'RELAY_BUSY', 'the refusal reaches the reviewer');
  assert.deepEqual(operations, ['reopen'], 'nothing is reserved after the return failed');
  assert.equal(store.itemById(board, id).item_review_by, null, 'the conflicting head is not reserved');
});

test('a return refused because the head already left review is a race, not a stop [C7,V4]', async (t) => {
  const { board, id, operations, run } = await refusedReturn(t, (raced, item) => {
    store.reopen(raced, item, { agentId: 'coordinator', note: 'another seat returned it first' });
    throw new Refused('NOT_SUBMITTED', `item #${item} is open, not submitted`);
  });
  await run();
  assert.deepEqual(operations, ['reopen', 'reserveNextReview'], 'the loop goes on to the next review');
  assert.equal(store.itemById(board, id).item_status, 'open');
});

/** Real Git conflicts and independent private SQLite copies distinguish review administration from agent authority. */
test('a fresh same-lane seat cannot reopen submitted conflicts under its grant [E21,V2,H16]', t => {
  const copies = [];
  t.after(() => copies.forEach(board => store.closeBoard(board)));
  const { box, json, conflicted } = staleHeadFixture(t);
  const fresh = join(box.dir, 'fresh-web-conflict-seat');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', fresh, 'main');
  const actor = json(fixtureJoin(box.run, fresh, 'web', '--json')).agent;
  const source = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  let snapshot;
  try { snapshot = exportBoard(source); } finally { store.closeBoard(source); }
  for (const name of ['coordinator-one', 'coordinator-two', 'agent-one', 'agent-two']) {
    const board = openBoard(join(box.dir, `${name}.sqlite`));
    copies.push(board);
    importBoard(board, snapshot);
  }
  const options = { sequence: 1, at: new Date().toISOString() };
  const conflict = { files: ['web/list.html'], trunk: box.git(box.repo, 'rev-parse', 'HEAD') };
  const positiveMove = prepareEngineMove(copies[0], 'reopen', [conflicted, { agentId: 'coordinator', conflict }]);
  const positive = copies.slice(0, 2).map(board => applyEngineMove(board, positiveMove, options));
  assert.deepEqual(positive[0], positive[1]);
  assert.equal(positive[0].error, undefined, 'the coordinator can return this actual conflicting head');
  const move = prepareEngineMove(copies[2], 'reopen', [conflicted, { agentId: actor, conflict }]);
  for (const board of copies.slice(2)) {
    assert.throws(() => applyEngineMove(board, { ...move, engine: AGENT_GRANT_ENGINE - 1 }, options),
      error => error.code === 'RELAY_MOVE' && error.message.includes(String(AGENT_GRANT_ENGINE)),
      'a newly joined seat cannot hide its current grant semantics behind an old engine tag');
  }
  const refused = copies.slice(2).map(board => applyEngineMove(board, move, options));
  assert.deepEqual(refused[0], refused[1]);
  assert.equal(refused[0].error?.code, 'COORDINATOR_ONLY', 'same-lane membership without a prior claim is not conflict-reopen authority');
  for (const board of copies.slice(2)) {
    assert.equal(store.getItem(board, conflicted).item_status, 'submitted', 'the refused agent move leaves the submission intact');
    assert.equal(store.getItem(board, conflicted).item_review_by, null, 'the refused agent move reserves no review');
  }
});


test('recorded pre-grant submitted-conflict moves retain joined-seat authority [V2,H16]', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-legacy-submitted-conflict-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  // Accepted pre-grant source writes its own historical events; no future marker is removed or fabricated.
  unpackRelease('e4b7c30d674cde73803f8e8cb3f53fb2f9f62621', directory);
  const legacyStore = await import(pathToFileURL(join(directory, 'src/board.js')).href);
  const legacyExchange = await import(pathToFileURL(join(directory, 'src/exchange.js')).href);
  const legacyEngine = await import(pathToFileURL(join(directory, 'src/engine.js')).href);
  const legacy = legacyStore.openBoard(':memory:');
  const copies = [openBoard(':memory:'), openBoard(':memory:')];
  t.after(() => { legacyStore.closeBoard(legacy); copies.forEach(board => store.closeBoard(board)); });
  legacyStore.register(legacy, { lane: 'coordinator', path: join(directory, 'main') });
  const builder = legacyStore.register(legacy, { lane: 'web', path: join(directory, 'builder') });
  const reporter = legacyStore.register(legacy, { lane: 'web', path: join(directory, 'reporter') });
  const id = legacyStore.addItem(legacy, { by: 'coordinator', lane: 'web', title: 'Historical conflict', criterion: 'Retain the submitted conflict.' });
  legacyStore.claim(legacy, id, { agentId: builder, lane: 'web', leaseMs: HOUR, freeze });
  // Synthetic board-state receipt only; this test makes no gate-execution claim.
  legacyStore.submit(legacy, id, { agentId: builder, commit: 'a'.repeat(40), tree: 'b'.repeat(40),
    submissionProof: { version: 1, files: [], full: false, deferred: true, reason: 'synthetic board-state fixture; no gate execution' } });
  const snapshot = legacyExchange.exportBoard(legacy);
  assert.ok(snapshot.tables.event.filter(row => ['join', 'claim'].includes(row.event_kind))
    .every(row => JSON.parse(row.event_detail).grantEngine === undefined), 'the accepted old writer emits no future grant marker');
  for (const board of copies) importBoard(board, snapshot);
  const move = legacyEngine.prepareEngineMove(legacy, 'reopen', [id, {
    agentId: reporter, conflict: { files: ['web/list.html'], trunk: 'c'.repeat(40) },
  }]);
  assert.ok(move.engine < AGENT_GRANT_ENGINE, 'the genuine writer predates the new authority fence');
  const receipt = { sequence: 1, at: new Date().toISOString() };
  const historical = legacyEngine.applyEngineMove(legacy, move, receipt);
  assert.equal(historical.error, undefined, 'the accepted historical engine permits its joined-seat report');
  for (const board of copies) {
    assert.deepEqual(applyEngineMove(board, move, receipt), historical, 'each current replica preserves the recorded outcome');
    assert.equal(store.getItem(board, id).item_status, 'open');
    assert.deepEqual(store.events(board), legacyStore.events(legacy), 'replay preserves historical event bytes');
  }
});


test('automatic conflict returns bind native evidence and replay without caller assertions [V4,H16]', t => {
  const copies = [];
  t.after(() => copies.forEach(board => store.closeBoard(board)));
  const { box, json, conflicted, reviewer, build } = staleHeadFixture(t);
  const source = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  copies.push(source);
  const actor = store.agentAt(source, reviewer).agent_id;
  const original = exportBoard(source);
  const move = prepareEngineMove(source, 'reopen', [conflicted, { agentId: actor, automaticConflict: true }]);
  const evidence = move.args[1].computedConflict;
  assert.equal(move.args[1].automaticConflict, undefined, 'a caller boolean does not enter the executable move');
  assert.equal(move.args[1].conflict, undefined, 'the agent asserts no conflict tuple');
  assert.equal(evidence.head, store.getItem(source, conflicted).item_commit);
  assert.equal(evidence.trunk, box.git(box.repo, 'rev-parse', 'HEAD'));
  assert.deepEqual(evidence.files, ['web/list.html']);
  assert.equal(evidence.actor, actor, 'the move retains the actual reviewer actor');
  /** Rehashing altered data must not make it trusted: immutable Git still decides the actual conflict. */
  const rehash = changes => {
    const { digest, ...fields } = { ...evidence, ...changes };
    return { ...fields, digest: createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
  };
  const forged = rehash({ files: ['web/false.html'] });
  for (const receipt of [forged, rehash({ head: evidence.trunk }), { ...evidence, files: ['web/false.html'] }]) {
    assert.throws(() => prepareEngineMove(source, 'reopen', [conflicted, { agentId: actor, computedConflict: receipt }]),
      error => error.code === 'COORDINATOR_ONLY', 'false or mutated conflict evidence cannot be sealed');
    assert.throws(() => store.reopen(source, conflicted, { agentId: actor, computedConflict: receipt }),
      error => error.code === 'COORDINATOR_ONLY', 'the direct origin API independently verifies the immutable conflict');
  }
  assert.deepEqual(exportBoard(source), original, 'evidence preparation and refusals do not change the board');
  /** Each independent SQLite replica verifies the recorded objects, without choosing its own current trunk. */
  const replica = name => {
    const board = openBoard(join(box.dir, `${name}.sqlite`));
    copies.push(board); importBoard(board, original); return board;
  };
  for (const [name, options] of [
    ['flag', { agentId: actor, automaticConflict: true }],
    ['mutated', { agentId: actor, computedConflict: { ...evidence, files: ['web/false.html'] } }],
    ['rehashed', { agentId: actor, computedConflict: forged }],
    ['clean-record', { agentId: actor, computedConflict: rehash({ trunk: evidence.head }) }],
    ['actor', { agentId: store.agentAt(source, box.web).agent_id, computedConflict: evidence }],
  ]) {
    const board = replica(name);
    const result = applyEngineMove(board, { ...move, id: `${move.id}-${name}`, args: [conflicted, options] },
      { sequence: 1, at: new Date().toISOString() });
    assert.equal(result.error?.code, 'COORDINATOR_ONLY', 'a flag, altered evidence or different actor grants no replay authority');
    assert.equal(store.getItem(board, conflicted).item_status, 'submitted');
  }
  const left = replica('missing-object-control');
  const missing = { ...move, args: [conflicted, { agentId: actor, computedConflict: rehash({ trunk: 'f'.repeat(40) }) }] };
  assert.throws(() => {
    const unexpected = applyEngineMove(left, missing, { sequence: 1, at: new Date().toISOString() });
    t.diagnostic('unexpected missing-object outcome: ' + JSON.stringify({ move: missing, outcome: unexpected }));
  }, error => error.code === 'MERGE_CHECK_FAILED', 'missing immutable objects refuse by name until fetched');
  assert.equal(appliedSequence(left), 0, 'a missing-object refusal does not consume the position needed after fetch');
  assert.throws(() => prepareEngineMove(left, 'reopen', [conflicted, { agentId: actor, automaticConflict: true }]),
    error => error.code === 'COORDINATOR_ONLY', 'an imported replica cannot fabricate native origin evidence');
  assert.throws(() => applyEngineMove(left, { ...move, engine: AGENT_GRANT_ENGINE - 1 }, { sequence: 1, at: new Date().toISOString() }),
    error => error.code === 'RELAY_MOVE', 'an older engine cannot interpret the new computed-return record');
  // Ruling 28066: preparation is not a recorded move. Seal the origin outcome before advancing main.
  const receipt = { sequence: 1, at: new Date().toISOString() };
  const origin = applyEngineMove(source, move, receipt);
  assert.equal(origin.error, undefined, 'the current-trunk origin move is recorded successfully');
  const sealed = exportBoard(source);
  const recorded = sealed.tables.board_meta.find(row => row.meta_key === 'relay_receipt_' + move.id);
  assert.equal(JSON.parse(recorded.meta_value).move, JSON.stringify(move), 'the snapshot retains the exact recorded move');
  // Main now contains the submitted head, while the recorded earlier trunk remains conflicting.
  box.git(box.repo, 'merge', '-q', '--no-edit', '-s', 'ours', evidence.head);
  const recordedCopies = ['sealed-left', 'sealed-right'].map(name => {
    const board = openBoard(join(box.dir, `${name}.sqlite`));
    copies.push(board); importBoard(board, sealed); return board;
  });
  const results = recordedCopies.map(board => applyEngineMove(board, move, receipt));
  assert.deepEqual(results[0], results[1]);
  assert.equal(results[0].error, undefined);
  assert.deepEqual(store.events(recordedCopies[0]), store.events(recordedCopies[1]));
  assert.equal(store.getItem(recordedCopies[0], conflicted).item_status, 'open');
  const second = join(box.dir, 'clean-computed-return');
  box.git(box.repo, 'worktree', 'add', '-q', second, '-b', 'web/clean-return', 'main');
  json(joinFixtureSeat(box, second, 'web'));
  const clean = build('Keep a clean footer', 'web/footer.html', '<footer>clean</footer>\n', second);
  assert.throws(() => prepareEngineMove(source, 'reopen', [clean, { agentId: actor, automaticConflict: true }]),
    error => error.code === 'NOT_CONFLICTING', 'a clean submitted head cannot acquire computed conflict evidence');
  assert.equal(store.getItem(source, clean).item_status, 'submitted');
});


/** Fresh requests cannot borrow an earlier conflict after the native trunk has made the submission clean. */
test('fresh conflict requests refuse an older trunk after main advances [V4,H16]', t => {
  const { box, conflicted, reviewer } = staleHeadFixture(t);
  const board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(board));
  const actor = store.agentAt(board, reviewer).agent_id;
  const prepared = prepareEngineMove(board, 'reopen', [conflicted, { agentId: actor, automaticConflict: true }]);
  const evidence = prepared.args[1].computedConflict;
  assert.ok(prepareEngineMove(board, 'reopen', [conflicted, { agentId: actor, computedConflict: evidence }]),
    'the current conflicting trunk permits normal preparation');
  box.git(box.repo, 'merge', '-q', '--no-edit', '-s', 'ours', evidence.head);
  assert.throws(() => prepareEngineMove(board, 'reopen', [conflicted, { agentId: actor, automaticConflict: true }]),
    error => error.code === 'NOT_CONFLICTING', 'native computation establishes that the current trunk is clean');
  const original = exportBoard(board);
  const { digest, ...fields } = evidence;
  fields.id = '11111111-2222-4333-8444-555555555555';
  fields.at = new Date(Date.parse(fields.at) + 1).toISOString();
  const stale = { ...fields, digest: createHash('sha256').update(JSON.stringify(fields)).digest('hex') };
  assert.throws(() => prepareEngineMove(board, 'reopen', [conflicted, { agentId: actor, computedConflict: stale }]),
    error => error.code === 'COORDINATOR_ONLY', 'a fresh self-hash does not authorize an earlier trunk');
  assert.throws(() => store.reopen(board, conflicted, { agentId: actor, computedConflict: stale }),
    error => error.code === 'COORDINATOR_ONLY', 'the direct mutation independently enforces the current trunk');
  assert.deepEqual(exportBoard(board), original, 'both fresh refusals leave the submission and event prefix unchanged');
  const replica = openBoard(join(box.dir, 'fresh-stale-replica.sqlite'));
  t.after(() => store.closeBoard(replica));
  importBoard(replica, original);
  const result = applyEngineMove(replica, { ...prepared, id: 'fresh-stale-request',
    args: [conflicted, { agentId: actor, computedConflict: stale }] }, { sequence: 1, at: stale.at });
  assert.equal(result.error?.code, 'COORDINATOR_ONLY', 'an unrecorded wire object is also a fresh request');
  assert.equal(store.getItem(replica, conflicted).item_status, 'submitted');
});


/** A cached immutable merge is not permission to replay through a locally overridden object graph. */
test('automatic conflict returns reject local history overrides before replay [V4,H16]', t => {
  const { box, conflicted, reviewer } = staleHeadFixture(t);
  const source = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  const copies = [source];
  t.after(() => copies.forEach(board => store.closeBoard(board)));
  const actor = store.agentAt(source, reviewer).agent_id;
  const snapshot = exportBoard(source);
  const move = prepareEngineMove(source, 'reopen', [conflicted, { agentId: actor, automaticConflict: true }]);
  const evidence = move.args[1].computedConflict;
  const receipt = { sequence: 1, at: new Date().toISOString() };
  const results = [];
  for (const kind of ['grafts', 'replace']) {
    const board = openBoard(join(box.dir, `history-${kind}.sqlite`));
    copies.push(board); importBoard(board, snapshot);
    // This positive preparation also warms the normal per-board immutable-object verification cache.
    assert.ok(prepareEngineMove(board, 'reopen', [conflicted, { agentId: actor, computedConflict: evidence }]));
    const graft = join(box.repo, '.git', 'info', 'grafts');
    if (kind === 'grafts') writeFileSync(graft, evidence.head + '\n');
    else box.git(box.repo, 'replace', evidence.head, evidence.trunk);
    try {
      assert.throws(() => applyEngineMove(board, move, receipt),
        error => error.code === (kind === 'grafts' ? 'GIT_GRAFTS' : 'GIT_REPLACE_REFS'),
        'local ancestry overrides refuse by name even after a prior clean verification');
      assert.equal(appliedSequence(board), 0, 'history refusal does not consume the replay cursor');
      assert.equal(store.getItem(board, conflicted).item_status, 'submitted');
    } finally {
      if (kind === 'grafts') rmSync(graft);
      else box.git(box.repo, 'replace', '-d', evidence.head);
    }
    results.push(applyEngineMove(board, move, receipt));
    assert.equal(results.at(-1).error, undefined, 'the same position succeeds once the private repository is clean');
  }
  assert.deepEqual(results[0], results[1], 'cleaned replicas apply the same actual recorded conflict');
});

test('a recorded automatic conflict return first replays after the replica trunk advances [V4,H16]', t => {
  const { box, json, conflicted, reviewer } = staleHeadFixture(t);
  const remote = join(box.dir, 'recorded-return.git');
  box.git(box.dir, 'clone', '--bare', box.repo, remote);
  box.git(box.repo, 'remote', 'add', 'origin', remote);
  json(box.run(box.repo, 'sync', '--json'));
  const replica = join(box.dir, 'behind-return-replica');
  box.git(box.dir, 'clone', remote, replica);
  const inheritedModel = box.env.PULLBOARD_MODEL;
  delete box.env.PULLBOARD_MODEL;
  try { assert.equal(box.run(replica, 'init').code, 0, 'initialize only the replica-local board'); }
  finally { if (inheritedModel !== undefined) box.env.PULLBOARD_MODEL = inheritedModel; }
  json(box.run(replica, 'sync', '--json'));
  const before = json(box.run(replica, 'export'));
  assert.equal(before.tables.item.find(item => item.item_id === conflicted).item_status, 'submitted');
  const origin = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => store.closeBoard(origin));
  const head = store.getItem(origin, conflicted).item_commit;
  const offered = box.run(reviewer, 'next', '--verify', '--json');
  assert.match(offered.err, /returned .*unreviewed/, 'the origin records its real current-trunk automatic return');
  const sealed = json(box.run(box.repo, 'export'));
  const record = sealed.tables.board_meta.filter(row => row.meta_key.startsWith('relay_receipt_'))
    .map(row => JSON.parse(row.meta_value)).find(receipt => JSON.parse(receipt.move).operation === 'reopen');
  assert.ok(record, 'the origin has an acknowledged exact move in its board log');
  assert.equal(record.outcome.error, undefined);
  assert.equal(before.tables.board_meta.some(row => row.meta_key === 'relay_receipt_' + JSON.parse(record.move).id), false,
    'the replica has never applied this position: this is not duplicate acknowledgement replay');
  box.git(box.repo, 'merge', '-q', '--no-edit', '-s', 'ours', head);
  box.git(replica, 'fetch', box.repo, 'main');
  box.git(replica, 'merge', '-q', '--ff-only', 'FETCH_HEAD');
  assert.notEqual(box.git(replica, 'rev-parse', 'HEAD'), JSON.parse(record.move).args[1].computedConflict.trunk);
  const fresh = openBoard(join(box.dir, 'fresh-stale-return.sqlite'));
  try {
    importBoard(fresh, before);
    const wire = JSON.parse(record.move);
    const options = wire.args[1];
    assert.throws(() => prepareEngineMove(fresh, 'reopen', wire.args), error => error.code === 'COORDINATOR_ONLY',
      'preparing the same now-stale evidence remains a fresh author request');
    assert.throws(() => store.reopen(fresh, conflicted, options), error => error.code === 'COORDINATOR_ONLY',
      'the direct board API cannot borrow recorded transport authority');
    const forged = applyEngineMove(fresh, { ...wire, args: [conflicted, { ...options,
      recorded: true, recordedConflictContext: { sequence: record.sequence, move: record.move } }] },
    { sequence: record.sequence, at: new Date().toISOString(), recorded: true });
    assert.equal(forged.error?.code, 'COORDINATOR_ONLY', 'caller-shaped context and generic engine replay grant no authority');
    assert.equal(store.getItem(fresh, conflicted).item_status, 'submitted');
  } finally { store.closeBoard(fresh); }
  json(box.run(replica, 'sync', '--json'));
  const replayed = json(box.run(replica, 'export'));
  assert.equal(replayed.tables.item.find(item => item.item_id === conflicted).item_status, 'open',
    'first delivery of the validated Git-log record uses its immutable recorded trunk, not current local main');
  const acknowledged = replayed.tables.board_meta.find(row => row.meta_key === 'relay_receipt_' + JSON.parse(record.move).id);
  assert.deepEqual(JSON.parse(acknowledged.meta_value).outcome, record.outcome);
});
