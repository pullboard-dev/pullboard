/** @pullboard-test-input source-tree */
/** Live routing uses computed native eligibility; legacy rule records and coded releases retain compatibility [C7,H16]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { board as store } from '../src/native-board.js';
import { reviewEligibility } from '../src/review-eligibility.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { dispatchWork } from '../src/dispatch-eligibility.js';
import { RELEASE_REASONS, STANDING_RULINGS, routingRuleProblem } from '../src/routing-rules.js';
import { migrateStandingRulings } from '../src/routing-rule-set.js';
import { effectiveAgentParent } from '../src/seat-review-read.js';
import shoutMove from '../src/moves/shout.js';
import releaseMove from '../src/moves/release.js';
import { ROUTING_RULES_ENGINE } from '../src/routing-rules-engine.js';
import { applyEngineMove, appliedSequence, prepareEngineMove } from '../src/engine.js';
import { createE2eHelpers } from './e2e-helpers.js';

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
  const rule = options => store.setRoutingRule(board, { agentId: 'coordinator', ...options });
  const review = agentId => store.nextFor(board, { agentId, lane: 'core', verify: true, policy: 'any', familyPolicy: 'off' });
  return { board, add, submit, rule, review, join };
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

test('planted stored routing records never replace computed next, dispatch, reservation or verdict eligibility [C7,V1,H16]', t => {
  const f = fixture(t), id = f.add();
  const item = f.submit(id);
  f.rule({ act: 'review', scope: { item: id }, effect: 'bar-family', value: 'claude', source: 32288 });
  assert.equal(routingRuleProblem(f.board, item, 'core-2', 'review')?.code, 'ROUTING_RULE',
    'the compatibility reader proves that the planted record really bars this seat in its retired model');
  const rules = store.routingRules(f.board);
  assertComputedReview(f, id, 'core-2');
  assert.deepEqual(store.routingRules(f.board), rules, 'live admission does not heal, revoke or rewrite stored records');
});

test('planted only-seat and build records do not override native computed review or claim guards [C7,V1]', t => {
  const f = fixture(t), id = f.add();
  f.submit(id);
  f.rule({ act: 'review', scope: { item: id }, effect: 'only-seat', value: 'core-4', source: 42630 });
  assertComputedReview(f, id, 'core-2');
  const open = f.add();
  f.rule({ act: 'build', scope: { item: open }, effect: 'bar-pool', value: 'core-2', source: 43048 });
  assert.equal(routingRuleProblem(f.board, store.getItem(f.board, open), 'core-2', 'build')?.code, 'ROUTING_RULE');
  const next = store.nextFor(f.board, { agentId: 'core-2', lane: 'core' });
  assert.equal(next.item?.item_id, open);
  assert.equal(dispatchWork(f.board, store.agentById(f.board, 'core-2')).item?.item_id, open);
  store.claim(f.board, open, { agentId: 'core-2', lane: 'core', leaseMs: LEASE, freeze });
  assert.equal(store.getItem(f.board, open).item_owner, 'core-2', 'the actual native claim succeeds without stored-rule authority');
});

test('only the coordinator sets a rule, a bad rule is refused, and an identical rule records once [C7]', t => {
  const f = fixture(t);
  assert.throws(() => store.setRoutingRule(f.board, { agentId: 'core-1', act: 'review', scope: { item: 1 }, effect: 'bar-seat', value: 'core-2', source: 1 }), { code: 'COORDINATOR_ONLY' });
  assert.throws(() => f.rule({ act: 'review', scope: { item: 1 }, effect: 'prefer', value: 'core-2', source: 1 }), { code: 'BAD_ROUTING_RULE' });
  assert.throws(() => f.rule({ act: 'review', scope: {}, effect: 'bar-seat', value: 'core-2', source: 1 }), { code: 'BAD_ROUTING_RULE' });
  const first = f.rule({ act: 'review', scope: { item: 1 }, effect: 'bar-seat', value: 'core-2', source: 1 });
  assert.equal(f.rule({ act: 'review', scope: { item: 1 }, effect: 'bar-seat', value: 'core-2', source: 1 }), first);
  assert.equal(store.routingRules(f.board).length, 1);
  f.rule({ revoke: first });
  assert.deepEqual(store.routingRules(f.board), []);
  assert.ok(store.events(f.board).some(event => event.event_kind === 'routing-rule'), 'each change is an event');
});

test('legacy standing-rule records retain compatibility reader bytes without live admission authority [C7]', t => {
  const f = fixture(t);
  const standard = f.submit(f.add());
  const strictCodex = f.submit(f.add({ sensitive: true }));
  const strictClaude = f.submit(f.add({ sensitive: true }), 'core-2');
  f.join('core-5', 'claude', 'd');
  const ids = migrateStandingRulings(f.board, 'coordinator');
  assert.deepEqual(migrateStandingRulings(f.board, 'coordinator'), ids, 'migrating twice records nothing new');
  const rules = store.routingRules(f.board);
  assert.equal(rules.length, STANDING_RULINGS.length);
  assert.deepEqual([...new Set(rules.map(rule => rule.source))].sort(), [32288, 42630, 43048]);
  assert.equal(routingRuleProblem(f.board, standard, 'core-4', 'review'), null, 'standard permits the same vendor from a different session');
  assert.equal(routingRuleProblem(f.board, standard, 'core-1', 'review')?.code, 'ROUTING_RULE', 'standard refuses the builder session');
  assert.equal(routingRuleProblem(f.board, strictCodex, 'core-2', 'review'), null);
  assert.equal(routingRuleProblem(f.board, strictCodex, 'core-4', 'review')?.code, 'ROUTING_RULE', 'strict needs a different vendor');
  assert.equal(routingRuleProblem(f.board, strictClaude, 'core-4', 'review'), null, 'a Claude-built strict item permits a non-Claude reviewer');
  assert.equal(routingRuleProblem(f.board, strictClaude, 'core-5', 'review')?.code, 'ROUTING_RULE', 'strict applies to every builder vendor');
  assert.equal(routingRuleProblem(f.board, { item_id: 1641, item_built_by: 'core-1' }, 'core-2', 'review')?.code, 'ROUTING_RULE', '#1641 is routed to one named seat');
  assert.equal(routingRuleProblem(f.board, { item_id: 1669, item_built_by: 'core-1' }, 'core-4', 'review')?.code, 'ROUTING_RULE', '#1669 goes to a claude reviewer');
  assert.equal(routingRuleProblem(f.board, { item_id: 1669, item_built_by: 'core-1' }, 'core-2', 'review'), null);
  assert.equal(routingRuleProblem(f.board, { item_id: 1669 }, 'core-4', 'build'), null, 'a review rule does not bar a build');
});

test('a release without a reason code is refused naming the list, and a coded release records it [C7]', () => {
  const box = helpers.project('true');
  const added = JSON.parse(box.run(box.repo, 'add', 'web', 'Release target', '--json').out).item.item_id;
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
  const historical = { ...prepareEngineMove(old.board, 'release', [historicalId, 'core-1', 'historical uncoded release'], { id: 'routing-release-historical' }), engine: ROUTING_RULES_ENGINE - 1 };
  assert.equal(applyEngineMove(old.board, historical, { sequence: 1, at: old.board.clock.now().toISOString() }).error, undefined);
  assert.equal(store.getItem(old.board, historicalId).item_status, 'open', 'the pre-routing engine preserves an old uncoded release');
});

test('computed session identity rejects shared parents and shared author sessions across native review paths [C7,V1,H16]', t => {
  for (const [reviewer, parent, session] of [['core-5', 'a', 'd'], ['core-6', 'd', 'a']]) {
    const f = fixture(t), id = f.add();
    f.submit(id);
    f.join(reviewer, 'claude', parent, session);
    if (parent === 'a') assert.equal(effectiveAgentParent(f.board, reviewer), effectiveAgentParent(f.board, 'core-1'));
    else assert.notEqual(effectiveAgentParent(f.board, reviewer), effectiveAgentParent(f.board, 'core-1'));
    assertComputedReview(f, id, reviewer, 'SELF_SESSION_VERIFY');
  }
  const independent = fixture(t), id = independent.add();
  independent.submit(id);
  independent.join('core-5', 'claude', 'b', 'd');
  assert.equal(effectiveAgentParent(independent.board, 'core-2'), effectiveAgentParent(independent.board, 'core-5'),
    'sharing another independent reviewer pool does not make it a builder pool');
  assertComputedReview(independent, id, 'core-5');
});

test('computed strict, required family, route and policy rules agree with native reservation and verdict [C7,V1,B13]', t => {
  for (const [itemOptions, agentId, code, policy] of [
    [{ sensitive: true }, 'core-4', 'O2_FAMILY_MATCH', {}],
    [{ reviewFamily: 'claude' }, 'core-4', 'REQUIRED_REVIEW_FAMILY', {}],
    [{}, 'core-2', 'COORDINATOR_VERIFIES', { policy: 'coordinator' }],
    [{}, 'core-4', 'O2_FAMILY_MATCH', { familyPolicy: 'require' }],
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

test('a rule-bearing native board fences fresh legacy shout and release senders [C7,H16]', t => {
  const f = fixture(t), id = f.add();
  const shoutArgs = [{ from: 'coordinator', to: 'all', text: 'A schema question remains open.' }];
  const releaseArgs = [id, 'core-1', 'Legacy reason text'];
  assert.ok(shoutMove.minimumEngine(shoutArgs, f.board, f.board.clock.now()) < ROUTING_RULES_ENGINE);
  assert.ok(releaseMove.minimumEngine(releaseArgs, f.board, f.board.clock.now()) < ROUTING_RULES_ENGINE);
  const rules = migrateStandingRulings(f.board, 'coordinator');
  assert.equal(shoutMove.minimumEngine(shoutArgs, f.board, f.board.clock.now()), ROUTING_RULES_ENGINE);
  assert.equal(releaseMove.minimumEngine(releaseArgs, f.board, f.board.clock.now()), ROUTING_RULES_ENGINE);
  for (const id of rules) f.rule({ revoke: id });
  assert.deepEqual(store.routingRules(f.board), []);
  assert.equal(shoutMove.minimumEngine(shoutArgs, f.board, f.board.clock.now()), ROUTING_RULES_ENGINE, 'revoking the final rule does not reset native message protocol');
  assert.equal(releaseMove.minimumEngine(releaseArgs, f.board, f.board.clock.now()), ROUTING_RULES_ENGINE, 'revoking the final rule cannot restore uncoded fresh releases');
});

test('a shout to the coordinator that routes work is answered with the rule command [C7]', () => {
  const box = helpers.project('true');
  const id = JSON.parse(box.run(box.repo, 'add', 'web', 'Routed by shout', '--json').out).item.item_id;
  for (const text of [`route #${id} to core-7`, `please review #${id} by core-7`, `assign #${id} to a claude reviewer`]) {
    const refused = box.run(box.web, 'shout', 'coordinator', text, '--kind', 'question', '--json');
    assert.notEqual(refused.code, 0, text);
    const error = JSON.parse(refused.out).error;
    assert.equal(error.code, 'ROUTING_BY_SHOUT');
    assert.match(error.message, new RegExp(`pullboard rule add review only-seat <seat> --item ${id}`, 'u'));
  }
  const fine = box.run(box.web, 'shout', 'coordinator', `is #${id} blocked on the schema?`, '--kind', 'question', '--json');
  assert.equal(fine.code, 0, fine.out + fine.err);
  for (const text of [`#${id}: release it; it goes to a Claude reviewer.`, `view-215 releases it and core-731 reviews #${id}.`, `review #${id} next`]) {
    const refused = box.run(box.repo, 'shout', 'web', text, '--json');
    assert.notEqual(refused.code, 0, text);
    assert.equal(JSON.parse(refused.out).error.code, 'ROUTING_BY_SHOUT');
  }
});

test('the native shout writer refuses coordinator assignments without persisting them and preserves older replay [C7,H16]', t => {
  const f = fixture(t), text = '#1669: release it; it goes to a Claude reviewer.';
  const before = store.events(f.board).length;
  assert.throws(() => store.shout(f.board, { from: 'coordinator', to: 'all', text, lanes: ['core'] }), { code: 'ROUTING_BY_SHOUT' });
  assert.equal(store.events(f.board).length, before, 'refusal writes no shout or event');
  f.board.executionEngineVersion = ROUTING_RULES_ENGINE - 1;
  assert.equal(typeof store.shout(f.board, { from: 'coordinator', to: 'all', text, lanes: ['core'] }), 'number', 'a genuine old recorded operation keeps its earlier meaning');
});
