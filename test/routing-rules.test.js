/** @pullboard-test-input source-tree */
/** Routing rulings are board records next enforces, and every release names a coded reason [C7,H16]. */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import * as store from '../src/board.js';
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

test('a seat barred by a recorded rule is never offered the review, by next or by reservation [C7]', t => {
  const f = fixture(t), id = f.add();
  f.submit(id);
  assert.equal(f.review('core-2').item?.item_id, id, 'before the rule the claude seat is offered the review');
  const ruleId = f.rule({ act: 'review', scope: { item: id }, effect: 'bar-family', value: 'claude', source: 32288 });
  const barred = f.review('core-2');
  assert.equal(barred.item, null, 'the barred seat is offered nothing');
  assert.match(barred.reasons.join('\n'), new RegExp(`routing rule #${ruleId} \\(shout 32288\\)`, 'u'), 'the refusal names the rule and its source shout');
  assert.equal(dispatchWork(f.board, store.agentById(f.board, 'core-2')).item, null, 'next --take shares the same filter');
  assert.throws(() => store.reserveReview(f.board, id, { agentId: 'core-2', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' }), { code: 'ROUTING_RULE' });
  assert.equal(store.getItem(f.board, id).item_review_by, null, 'a refused reservation reserves nothing');
});

test('an eligible seat is still offered the review and the build [C7]', t => {
  const f = fixture(t), id = f.add();
  f.submit(id);
  f.rule({ act: 'review', scope: { item: id }, effect: 'only-seat', value: 'core-4', source: 42630 });
  assert.equal(f.review('core-4').item?.item_id, id);
  assert.equal(dispatchWork(f.board, store.agentById(f.board, 'core-4')).item?.item_id, id);
  assert.equal(f.review('core-2').item, null, 'only the routed seat reviews');
  const open = f.add();
  f.rule({ act: 'build', scope: { item: open }, effect: 'bar-pool', value: 'core-2', source: 43048 });
  const seen = agentId => store.nextFor(f.board, { agentId, lane: 'core' });
  assert.notEqual(seen('core-2').item?.item_id, open, 'the barred builder is not offered the item');
  assert.equal(seen('core-4').item?.item_id, open, 'another builder is');
  assert.throws(() => store.claim(f.board, open, { agentId: 'core-2', lane: 'core', leaseMs: LEASE, freeze }), { code: 'ROUTING_RULE' });
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

test('the standing rulings are rules, each naming its source shout, and they are enforced [C7]', t => {
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

test('a session rule reads the persisted session separately from its shared parent pool [C7]', t => {
  const f = fixture(t), id = f.add();
  f.submit(id);
  f.join('core-5', 'claude', 'b', 'd');
  const session = 'b'.repeat(64);
  assert.equal(effectiveAgentParent(f.board, 'core-2'), effectiveAgentParent(f.board, 'core-5'), 'these sessions share one parent pool');
  assert.notEqual(effectiveAgentParent(f.board, 'core-4'), session, 'the fixture seats have distinct lineages');
  const bar = f.rule({ act: 'review', scope: { item: id }, effect: 'bar-session', value: session, source: 43048 });
  assert.equal(f.review('core-2').item, null, 'the barred session is offered nothing');
  assert.equal(f.review('core-4').item?.item_id, id, 'another session is');
  assert.equal(f.review('core-5').item?.item_id, id, 'a different session in the barred session\'s parent pool remains eligible');
  f.rule({ revoke: bar });
  f.rule({ act: 'review', scope: { item: id }, effect: 'require-session', value: session, source: 43048 });
  assert.equal(f.review('core-2').item?.item_id, id, 'the required session is offered the review');
  assert.equal(f.review('core-4').item, null, 'every other session is barred');
  assert.equal(f.review('core-5').item, null, 'sharing the required session\'s parent does not satisfy a session requirement');
  assert.throws(() => store.reserveReview(f.board, id, { agentId: 'core-4', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' }), { code: 'ROUTING_RULE' });
});

test('family rules use the native immutable declaration and unknown sessions cannot evade session rules [C7]', t => {
  const f = fixture(t), id = f.add();
  f.submit(id);
  f.rule({ act: 'review', scope: { item: id }, effect: 'require-family', value: 'claude', source: 43048 });
  f.board.db.prepare('UPDATE agent SET agent_family=? WHERE agent_id=?').run('stale physical label', 'core-2');
  assert.equal(f.review('core-2').item?.item_id, id, 'the immutable native declaration still says Claude');
  f.rule({ act: 'review', scope: { item: id }, effect: 'bar-session', value: 'b'.repeat(64), source: 43048 });
  store.register(f.board, { id: 'core-6', lane: 'core', path: '/fixture/core-6', family: 'claude', model: 'Synthetic fixture model' });
  assert.equal(f.review('core-6').item, null, 'missing session metadata never establishes that this seat is outside a barred session');
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
