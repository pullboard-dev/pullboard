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
import { createE2eHelpers } from './e2e-helpers.js';

const LEASE = 3_600_000;
const freeze = () => ({ text: '{}', digest: 'synthetic-routing-bar' });
const helpers = createE2eHelpers();
after(helpers.cleanup);

/** Four declared seats: a codex builder, a claude seat, a second codex seat, and the coordinator. */
function fixture(t) {
  const board = fixtureBoard(t);
  const join = (id, family, parent) => store.register(board, { id, lane: id === 'coordinator' ? 'coordinator' : 'core', path: `/fixture/${id}`,
    family, parentDigest: parent.repeat(64), model: 'Synthetic fixture model' });
  join('coordinator', 'human', 'e');
  join('core-1', 'codex', 'a');
  join('core-2', 'claude', 'b');
  join('core-4', 'codex', 'c');
  const add = options => store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Routing fixture', ...options });
  const submit = (id, builder = 'core-1') => {
    store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: LEASE, freeze });
    submitFixture(board, id, { agentId: builder, commit: String(id).padStart(40, 'a'), tree: 'b'.repeat(40) });
  };
  const rule = options => store.setRoutingRule(board, { agentId: 'coordinator', ...options });
  const review = agentId => store.nextFor(board, { agentId, lane: 'core', verify: true, policy: 'any', familyPolicy: 'off' });
  return { board, add, submit, rule, review };
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
  const ids = migrateStandingRulings(f.board, 'coordinator');
  assert.deepEqual(migrateStandingRulings(f.board, 'coordinator'), ids, 'migrating twice records nothing new');
  const rules = store.routingRules(f.board);
  assert.equal(rules.length, STANDING_RULINGS.length);
  assert.deepEqual([...new Set(rules.map(rule => rule.source))].sort(), [32288, 42630, 43048]);
  for (const strict of [346, 408, 348]) {
    assert.equal(routingRuleProblem(f.board, { item_id: strict }, 'core-2', 'review'), null, 'a claude reviewer may review a strict item');
    assert.equal(routingRuleProblem(f.board, { item_id: strict }, 'core-1', 'review')?.code, 'ROUTING_RULE', 'a codex seat may not');
  }
  assert.equal(routingRuleProblem(f.board, { item_id: 1641 }, 'core-2', 'review')?.code, 'ROUTING_RULE', '#1641 is routed to one named seat');
  assert.equal(routingRuleProblem(f.board, { item_id: 1669 }, 'core-4', 'review')?.code, 'ROUTING_RULE', '#1669 goes to a claude reviewer');
  assert.equal(routingRuleProblem(f.board, { item_id: 1669 }, 'core-2', 'review'), null);
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

test('a rule can bar or require by session lineage [C7]', t => {
  const f = fixture(t), id = f.add();
  f.submit(id);
  const session = effectiveAgentParent(f.board, 'core-2');
  assert.notEqual(effectiveAgentParent(f.board, 'core-4'), session, 'the fixture seats have distinct lineages');
  const bar = f.rule({ act: 'review', scope: { item: id }, effect: 'bar-session', value: session, source: 43048 });
  assert.equal(f.review('core-2').item, null, 'the barred session is offered nothing');
  assert.equal(f.review('core-4').item?.item_id, id, 'another session is');
  f.rule({ revoke: bar });
  f.rule({ act: 'review', scope: { item: id }, effect: 'require-session', value: session, source: 43048 });
  assert.equal(f.review('core-2').item?.item_id, id, 'the required session is offered the review');
  assert.equal(f.review('core-4').item, null, 'every other session is barred');
  assert.throws(() => store.reserveReview(f.board, id, { agentId: 'core-4', leaseMs: LEASE, policy: 'any', familyPolicy: 'off' }), { code: 'ROUTING_RULE' });
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
});
