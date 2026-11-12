/** Live routing uses computed native eligibility; legacy rule records and coded releases retain compatibility [C7,H16]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { board as store } from '../../../lib/index.js';
import { reviewEligibility } from '../../../../packages/verify/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { dispatchWork } from '../../../../packages/store/index.js';
import { recordSubmitHandoff } from '../../../../packages/jobs/index.js';
import { RELEASE_REASONS } from '../../../../packages/store/index.js';
import { effectiveAgentParent } from '../../../../packages/seats/index.js';
import { RELEASE_REASONS_ENGINE } from '../../../../packages/state/light.js';
import {
  applyEngineMove,
  appliedSequence,
  prepareEngineMove,
} from '../../../../packages/state/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';
import { parentSessionDigest } from '../../../../packages/items/index.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { requireSessionIndependence } from '../../tests/fixtures/testkit.js';

const LEASE = 3_600_000;
const freeze = () => ({ text: '{}', digest: 'synthetic-routing-bar' });
const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Four declared seats: a codex builder, a claude seat, a second codex seat, and the coordinator. */
function fixture(t) {
  const board = fixtureBoard(t);
  const join = (id, family, parent, session = parent) => store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`,
    family, parentDigest: parent.repeat(64), sessionDigest: session.repeat(64), model: 'Synthetic fixture model' });
  join('coordinator', 'human', 'e');
  join('core-1', 'codex', 'a');
  join('core-2', 'claude', 'b');
  join('core-4', 'codex', 'c');
  const add = options => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Routing fixture', ...options });
  const submit = (id, builder = 'core-1') => {
    store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: LEASE, freeze });
    submitFixture(board, id, { agentId: builder, commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
    return store.getItem(board, id);
  };
  const review = agentId => store.nextFor(board, { agentId, lane: 'core', verify: true, policy: 'any', familyPolicy: 'off' });
  return { board, add, submit, review, join };
}

/** Compare computed selection/projection/dispatch with actual native reservation and verdict guards. */
function assertComputedReview(f, id, agentId, expectedCode = null, options = {}) {
  const who = { agentId, policy: 'any', familyPolicy: 'off', ...options };
  const item = store.getItem(f.board, id), before = store.events(f.board);
  let problem = null;
  for (const check of Object.values(store.reviewerChecks(f.board, who))) {
    problem = check(item);
    if (problem) break;
  }
  assert.equal(problem?.code ?? null, expectedCode, 'hand-specified computed guard result');
  const view = reviewEligibility(f.board, item, options);
  assert.equal(view.eligible.includes(agentId), expectedCode === null);
  if (expectedCode) assert.equal(view.ineligible.find(row => row.agent === agentId)?.code, expectedCode);
  const next = store.nextFor(f.board, { ...who, lane: 'core', verify: true });
  const dispatched = dispatchWork(f.board, store.agentById(f.board, agentId), options);
  const verdict = { ...who, decision: 'ACCEPT', head: item.item_commit,
    digest: item.item_frozen_digest, note: 'Private component comparison of actual native eligibility guards.' };
  if (expectedCode) {
    assert.equal(next.item, null);
    assert.equal(dispatched.item, null);
    assert.throws(() => store.reserveReview(f.board, id, { ...who, leaseMs: LEASE }), { code: expectedCode });
    assert.throws(() => store.verify(f.board, id, verdict), { code: expectedCode });
    assert.deepEqual(store.getItem(f.board, id), item, 'both refused native admissions preserve the submitted row');
    assert.deepEqual(store.events(f.board), before, 'both refused admissions append nothing');
  } else {
    assert.equal(next.item?.item_id, id);
    assert.equal(dispatched.item?.item_id, id);
    assert.equal(dispatched.review, true);
    assert.equal(store.reserveReview(f.board, id, { ...who, leaseMs: LEASE }).item_review_by, agentId);
    assert.deepEqual(store.nextFor(f.board, { ...who, lane: 'core', verify: true }),
      { item: store.listItems(f.board).find(row => row.item_id === id), reasons: [] }, 'own held review retains its historical return shape');
    assert.equal(store.verify(f.board, id, verdict).decision, 'ACCEPT');
    assert.equal(store.getItem(f.board, id).item_verified_by, agentId);
  }
}

test('a release without a reason code is refused naming the list, and a coded release records it [C7]', () => {
  const box = helpers.project('true');
  const added = JSON.parse(fixtureAdd(box.run, box.repo, 'web', 'Release target', '--json').out).item.item_id;
  const claim = box.run(box.web, 'claim', String(added), '--json');
  assert.equal(claim.code, 0, claim.err + claim.out);
  const bare = box.run(box.web, 'release', String(added), '--json');
  assert.notEqual(bare.code, 0);
  const error = JSON.parse(bare.out).error;
  assert.equal(error.code, 'RELEASE_REASON');
  for (const code of RELEASE_REASONS) assert.match(error.message, new RegExp(code, 'u'), `the refusal lists ${code}`);
  assert.notEqual(box.run(box.web, 'release', String(added), '--reason', 'NOPE', '--json').code, 0, 'a code outside the list is refused');
  assert.notEqual(box.run(box.web, 'release', String(added), '--reason', 'OTHER', '--json').code, 0, 'OTHER needs its text');
  const released = box.run(box.web, 'release', String(added), '--reason', 'OTHER', '--note', 'the toolchain is down', '--json');
  assert.equal(released.code, 0, released.err + released.out);
  const log = JSON.parse(box.run(box.repo, 'log', String(added), '--json').out).events.findLast(event => event.event_kind === 'release');
  assert.equal(JSON.parse(log.event_detail ?? JSON.stringify(log.detail ?? {})).reasonCode, 'OTHER');
});

test('native and ordered releases require a reason code while historical releases keep their meaning [C7,H16]', t => {
  const f = fixture(t), id = f.add();
  store.claim(f.board, id, { agentId: 'core-1', lane: 'core', leaseMs: LEASE, freeze });
  const before = store.getItem(f.board, id), events = store.events(f.board);
  for (const code of [undefined, 'NOPE', 'OTHER']) {
    assert.throws(() => store.release(f.board, id, 'core-1', '', code), { code: 'RELEASE_REASON' });
    assert.deepEqual(store.getItem(f.board, id), before, 'a direct refused release preserves the claim');
    assert.deepEqual(store.events(f.board), events, 'a direct refusal appends nothing');
  }
  const at = f.board.clock.now().toISOString();
  const bare = prepareEngineMove(f.board, 'release', [id, 'core-1', 'dependency merge conflict'], { id: 'routing-release-no-code' });
  const refused = applyEngineMove(f.board, bare, { sequence: 1, at });
  assert.equal(refused.error.code, 'RELEASE_REASON', 'the engine enforces the code without a CLI');
  assert.deepEqual(store.getItem(f.board, id), before);
  assert.deepEqual(store.events(f.board), events);
  assert.equal(appliedSequence(f.board), 1, 'an admitted refusal retains its normal replay receipt and cursor');
  assert.deepEqual(applyEngineMove(f.board, bare, { sequence: 1, at }), refused, 'duplicate refusal replay is stable');
  const coded = prepareEngineMove(f.board, 'release', [id, 'core-1', 'dependency merge conflict', 'BLOCKED'], { id: 'routing-release-blocked' });
  assert.equal(applyEngineMove(f.board, coded, { sequence: 2, at }).error, undefined);
  assert.equal(store.getItem(f.board, id).item_status, 'open');
  assert.equal(JSON.parse(store.events(f.board).findLast(event => event.event_kind === 'release').event_detail).reasonCode, 'BLOCKED');
  const old = fixture(t), historicalId = old.add();
  store.claim(old.board, historicalId, { agentId: 'core-1', lane: 'core', leaseMs: LEASE, freeze });
  const historical = { ...prepareEngineMove(old.board, 'release', [historicalId, 'core-1', 'historical uncoded release'], { id: 'routing-release-historical' }), engine: RELEASE_REASONS_ENGINE - 1 };
  assert.equal(applyEngineMove(old.board, historical, { sequence: 1, at: old.board.clock.now().toISOString() }).error, undefined);
  assert.equal(store.getItem(old.board, historicalId).item_status, 'open', 'the pre-routing engine preserves an old uncoded release');
});

test('computed parent identity rejects the builder pool across native review paths [C7,V1,H16]', t => {
  const shared = fixture(t), sharedId = shared.add();
  shared.submit(sharedId);
  shared.join('core-5', 'claude', 'a', 'd');
  assert.equal(effectiveAgentParent(shared.board, 'core-5'), effectiveAgentParent(shared.board, 'core-1'));
  assertComputedReview(shared, sharedId, 'core-5', 'SELF_SESSION_VERIFY');
  const independent = fixture(t), id = independent.add();
  independent.submit(id);
  independent.join('core-5', 'claude', 'b', 'd');
  assert.equal(effectiveAgentParent(independent.board, 'core-2'), effectiveAgentParent(independent.board, 'core-5'),
    'sharing another independent reviewer pool does not make it a builder pool');
  assertComputedReview(independent, id, 'core-5');
});

test('CLI next and verify reject the original building session through its real local ledger [C7,V1,B3]', t => {
  const box = crossLaneFixture(t);
  // The kit joins box.web as an ordinary seat; the original session builds in its own fresh worktree instead (#3103).
  const built = join(box.dir, 'original-session-build');
  box.git(box.repo, 'worktree', 'add', '-q', '-b', 'web/original-session', built, 'main');
  const original = 'routing-ledger-original-session', other = 'routing-ledger-independent-session';
  const builder = box.json(box.runAs(original, built, 'join', 'web', '--family', 'codex',
    '--parent', 'routing-builder-parent', '--model', 'Private session fixture', '--route', 'strong', '--json')).agent;
  const id = box.add('web', 'Session independence through the local ledger');
  box.json(box.runAs(original, built, 'claim', String(id), '--json'));
  const commit = helpers.commitFile(box, built, 'web/session.txt', 'built by the original session\n',
    'test(web): build the private session fixture [G1]');
  assert.equal(commit.status, 0, commit.stdout + commit.stderr);
  box.json(box.runAs(original, built, 'submit', String(id), '--no-next', '--json'));
  const review = join(box.dir, 'original-session-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, box.git(built, 'rev-parse', 'HEAD'));
  requireSessionIndependence(review);
  const reviewer = box.json(box.runAs(original, review, 'join', 'web', '--family', 'codex',
    '--parent', 'routing-review-parent', '--model', 'Private session fixture', '--route', 'strong', '--json')).agent;
  assert.notEqual(reviewer, builder, 'the review seat is not the building seat');
  const builtBinding = box.binding(built), reviewBinding = box.binding(review);
  assert.equal(builtBinding.agent, builder);
  assert.equal(reviewBinding.agent, reviewer);
  assert.match(builtBinding.digest, /^[a-f0-9]{64}$/u);
  assert.equal(reviewBinding.digest, builtBinding.digest, 'both checkouts are bound by the real original CLI session');
  const agents = box.json(box.runAs(original, review, 'status', '--json')).agents;
  const buildSeat = agents.find(seat => seat.agent_id === builder), reviewSeat = agents.find(seat => seat.agent_id === reviewer);
  assert.equal(buildSeat.agent_parent_session, parentSessionDigest('routing-builder-parent'));
  assert.equal(reviewSeat.agent_parent_session, parentSessionDigest('routing-review-parent'));
  assert.notEqual(buildSeat.agent_parent_session, reviewSeat.agent_parent_session,
    'the CLI ledger control does not obtain its refusal from the board-only shared-parent guard');
  assert.equal(buildSeat.agent_family, 'codex');
  assert.equal(reviewSeat.agent_family, 'codex', 'one original session retains its declared family');
  const ledger = readFileSync(resolve(box.repo, box.git(box.repo, 'rev-parse', '--git-common-dir'),
    'pullboard', 'item-sessions.jsonl'), 'utf8');
  const moves = ledger.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.item === id);
  for (const move of ['claim', 'submit']) assert.ok(moves.some(row => row.move === move && row.digest === builtBinding.digest),
    'the actual ' + move + ' command recorded this item and the original digest');
  assert.equal(ledger.includes(original), false, 'the real ledger stores a digest rather than the raw session');
  const before = box.json(box.run(review, 'show', String(id), '--json'));
  const events = box.json(box.run(review, 'log', String(id), '--json')).events;
  for (const args of [
    ['next', '--verify', String(id), '--json'],
    ['verify', String(id), 'accept', '--note', 'The original building session must not decide.', '--no-next', '--json'],
  ]) {
    const refused = box.runAs(original, review, ...args);
    assert.notEqual(refused.code, 0, refused.out + refused.err);
    assert.equal(JSON.parse(refused.out).error.code, 'SELF_SESSION_VERIFY');
    assert.deepEqual(box.json(box.run(review, 'show', String(id), '--json')), before,
      'the refused command preserves the complete item detail');
    assert.deepEqual(box.json(box.run(review, 'log', String(id), '--json')).events, events,
      'the refused command records no item event');
  }
  const excluded = box.runAs(original, review, 'next', '--verify', '--json');
  assert.equal(excluded.code, 1, excluded.out + excluded.err);
  assert.equal(JSON.parse(excluded.out).error.code, 'NOTHING_FREE',
    'unnamed next excludes the original session item and retains its ordinary empty-queue refusal');
  const afterExcluded = box.json(box.run(review, 'show', String(id), '--json'));
  assert.deepEqual(afterExcluded, before, 'empty-queue refusal preserves the complete item detail');
  assert.equal(afterExcluded.item_review_by, null, 'the original session acquired no review reservation');
  assert.deepEqual(box.json(box.run(review, 'log', String(id), '--json')).events, events);
  box.json(box.runAs(other, review, 'takeover', '--json'));
  const independent = box.binding(review);
  assert.equal(independent.agent, reviewer);
  assert.notEqual(independent.digest, builtBinding.digest, 'the positive command runs in a genuine other session');
  const next = box.json(box.runAs(other, review, 'next', '--verify', String(id), '--json'));
  assert.equal(next.item.item_id, id);
  assert.equal(next.item.item_review_by, reviewer, 'the independent session obtains the actual native reservation');
  const accepted = box.json(box.runAs(other, review, 'verify', String(id), 'accept',
    '--note', 'Independent private session checked the actual submitted source.', '--no-next', '--json'));
  assert.equal(accepted.decision, 'ACCEPT');
});

test('computed strict, required family, route and policy rules agree with native reservation and verdict [C7,V1,B13]', t => {
  for (const [itemOptions, agentId, code, policy] of [
    [{ sensitive: true }, 'core-4', 'SAME_FAMILY', {}],
    [{ reviewFamily: 'claude' }, 'core-4', 'REQUIRED_REVIEW_FAMILY', {}],
    [{}, 'core-2', 'COORDINATOR_VERIFIES', { policy: 'coordinator' }],
    [{}, 'core-4', 'SAME_FAMILY', { familyPolicy: 'require' }],
    [{}, 'core-8', 'ROUTE', {}],
  ]) {
    const f = fixture(t), id = f.add(itemOptions);
    f.submit(id);
    if (agentId === 'core-8') store.register(f.board, { id: agentId, lane: 'core', path: '/fixture/core-8',
      route: 'light', family: 'claude', parentDigest: 'f'.repeat(64), sessionDigest: 'f'.repeat(64), model: 'Synthetic fixture model' });
    assertComputedReview(f, id, agentId, code, policy);
  }
  for (const itemOptions of [{ sensitive: true }, { reviewFamily: 'claude' }]) {
    const f = fixture(t), id = f.add(itemOptions);
    f.submit(id);
    f.board.db.prepare('UPDATE agent SET agent_family=? WHERE agent_id=?').run('stale physical label', 'core-2');
    assertComputedReview(f, id, 'core-2');
  }
});

test('computed review selection preserves held diagnostics, coded-release cooldown and another eligible seat [C7,V1]', t => {
  const f = fixture(t), id = f.add();
  f.submit(id);
  store.reserveReview(f.board, id, { agentId: 'core-2', leaseMs: LEASE, policy: 'any' });
  const held = f.review('core-4');
  assert.equal(held.item, null);
  assert.match(held.reasons.join('\n'), new RegExp('core-2 holds the review of #' + id, 'u'));
  assert.deepEqual(Object.keys(held), ['item', 'reasons'], 'ordinary query shape gains no diagnostic field');
  assert.throws(() => store.reserveReview(f.board, id, { agentId: 'core-4', leaseMs: LEASE, policy: 'any' }), { code: 'REVIEW_HELD' });
  assert.equal(store.release(f.board, id, 'core-2', 'Private component handoff after native eligibility comparison.', undefined, 'BLOCKED'), true);
  const cooling = f.review('core-2');
  assert.equal(cooling.item, null);
  assert.match(cooling.reasons.join('\n'), /you released the review/u);
  assert.throws(() => store.reserveReview(f.board, id, { agentId: 'core-2', leaseMs: LEASE, policy: 'any' }), { code: 'REVIEW_COOLDOWN' });
  assert.equal(f.review('core-4').item?.item_id, id, 'the release cooldown is specific to the releasing reviewer');
  assertComputedReview(f, id, 'core-4');
});

test('computed review filtering preserves native urgency, skip and omit ordering [C7,V1,N2]', t => {
  const f = fixture(t), first = f.add(), second = f.add();
  f.submit(first);
  f.submit(second);
  /** Exercise the real query with only its existing selection options. */
  const next = options => store.nextFor(f.board, { agentId: 'core-2', lane: 'core', verify: true,
    policy: 'any', familyPolicy: 'off', ...options });
  const before = store.events(f.board);
  assert.equal(next({}).item?.item_id, first, 'the oldest native submission remains first');
  assert.equal(next({ priority: [second] }).item?.item_id, second, 'actual main-red urgency still precedes age');
  assert.equal(next({ skipIds: [first] }).item?.item_id, second);
  assert.equal(next({ omitIds: [first] }).item?.item_id, second);
  assert.deepEqual(store.events(f.board), before, 'all ordering probes remain read-only');
});

test('clause 1 and clause 2: a claim whose own gate stopped on infrastructure leaves its seat free to review; other claims stay held [C7,N41]', t => {
  const f = fixture(t), waiting = f.add(), own = f.add();
  f.submit(waiting);
  store.claim(f.board, own, { agentId: 'core-2', lane: 'core', leaseMs: LEASE, freeze });
  const claimed = store.getItem(f.board, own);
  /** Record the claim's own queued gate in the given terminal state, as the handoff worker does. */
  const gate = (state, code) => recordSubmitHandoff(f.board.db, own, { id: `fixture-job-${state}`, commit: 'c'.repeat(40), agentId: 'core-2', digest: claimed.item_frozen_digest, state, at: '2026-11-04T19:32:13.780Z', error: { code, message: 'fixture', next: 'fixture' } });
  const seat = store.agentById(f.board, 'core-2');
  assert.deepEqual([dispatchWork(f.board, seat).item?.item_id, dispatchWork(f.board, seat).held], [own, true], 'with no gate the claim is held');
  gate('red', 'GATE_RED');
  assert.equal(dispatchWork(f.board, seat).item?.item_id, own, 'a red gate returns the claim to its builder');
  gate('infrastructure', 'GATE_INFRA_EXHAUSTED');
  const offered = dispatchWork(f.board, seat);
  assert.deepEqual([offered.item?.item_id, offered.review], [waiting, true], 'an infrastructure stop frees the seat for the waiting review');
  assert.notEqual(dispatchWork(f.board, store.agentById(f.board, 'core-1')).item?.item_id, waiting, 'its builder is still never offered its own review');
});
