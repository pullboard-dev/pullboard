/** The lifecycle rules replay recorded facts, agree with a clean history, and name each disagreement by event id [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareFinal } from '../../index.js';
import { lifecycleFact } from '../../index.js';
import { readiness } from '../../index.js';
import { replay } from '../../index.js';
import { topKinds } from '../../index.js';
import { trial } from '../../index.js';

let counter = 0;
/** One recorded fact; minutes advance so lease checks have a clock. */
function fact(kind, item, by, extra = {}) {
  counter += 1;
  return lifecycleFact({ id: counter, at: new Date(Date.UTC(2026, 10, 1, 0, counter)).toISOString(), by, kind, item, ...extra });
}
const hour = counter => new Date(Date.UTC(2026, 10, 1, 1, counter)).toISOString();

/** A whole clean life: add, claim, renew, submit, reserve, accept, land, review. */
const CLEAN = () => [
  fact('add', 1, 'coordinator', { after: '[]' }),
  fact('claim', 1, 'core-1', { leaseUntil: hour(0) }),
  fact('renew', 1, 'core-1', { leaseUntil: hour(0) }),
  fact('submit', 1, 'core-1'),
  fact('reserve', 1, 'core-2'),
  fact('accept', 1, 'core-2'),
  fact('merged', 1, 'coordinator'),
  fact('verify', 1, 'core-2'),
];

test('moves.lifecycle-replay.clean-history-agrees-every-rule-final: clause 2: a clean history agrees with every rule and the final state matches the board [C7]', () => {
  const run = replay(CLEAN());
  assert.equal(run.judged, 8);
  assert.equal(run.agreed, 8);
  assert.deepEqual(run.disagreements, []);
  assert.equal(run.items.get(1).status, 'verified');
  assert.deepEqual(compareFinal(run.items, [{ id: 1, status: 'verified', owner: null, held: false, after: [] }]).mismatches, []);
});

test('moves.lifecycle-replay.move-rules-refuse-listed-event-id: clause 2: a move the rules refuse is listed with its event id, rule and cause, and replay continues [C7]', () => {
  const facts = [
    fact('add', 2, 'coordinator', { after: '[]' }),
    fact('claim', 2, 'core-1', { leaseUntil: hour(0) }),
    fact('submit', 2, 'core-1'),
    fact('accept', 2, 'core-1'),
    fact('merged', 2, 'coordinator'),
  ];
  const report = trial(facts, [{ id: 2, status: 'verified', owner: null, held: false, after: [] }]);
  assert.equal(report.judged, 5);
  assert.equal(report.agreed, 4);
  assert.equal(report.rate, 0.8);
  assert.equal(report.disagreements.length, 1);
  const [one] = report.disagreements;
  assert.equal(one.event, facts[3].id);
  assert.equal(one.kind, 'accept: SELF_VERIFY');
  assert.equal(report.final.agreed, 1, 'the board did accept it, and the replay follows the board');
});

test('moves.lifecycle-replay.forced-landing-claim-over-live-lease: clause 2: a forced landing and a claim over a live lease are separate disagreement kinds [C7]', () => {
  const facts = [
    fact('add', 3, 'coordinator', { after: '[]' }),
    fact('claim', 3, 'core-1', { leaseUntil: hour(30) }),
    fact('claim', 3, 'core-2', { leaseUntil: hour(40) }),
    fact('merged', 3, 'coordinator', { forced: 1, fromState: 'claimed' }),
  ];
  const kinds = topKinds(replay(facts).disagreements).map(group => group.kind).sort();
  assert.deepEqual(kinds, ['claim: HELD', 'merged: NOT_VERIFIED (forced from claimed)']);
});

test('moves.lifecycle-replay.readiness-derived-once-open-held-every: clause 1: readiness is derived once: open, not held, and every dependency verified [C7]', () => {
  const facts = [
    fact('add', 10, 'coordinator', { after: '[]' }),
    fact('add', 11, 'coordinator', { after: '[10]' }),
    fact('add', 12, 'coordinator', { after: '[]' }),
    fact('hold_item', 12, 'coordinator'),
  ];
  const { items } = replay(facts);
  assert.deepEqual(readiness(items.get(10), items), { ready: true, blocked: false, held: false, unmet: [] });
  assert.deepEqual(readiness(items.get(11), items).unmet, [{ id: 10, state: 'open' }]);
  assert.equal(readiness(items.get(11), items).ready, false);
  assert.equal(readiness(items.get(12), items).held, true);
  assert.equal(readiness(items.get(12), items).ready, false);
  const claimBlocked = replay([...facts, fact('claim', 11, 'core-1', { leaseUntil: hour(50) })]);
  assert.equal(claimBlocked.disagreements[0].kind, 'claim: BLOCKED (waits on a open item)');
});

test('moves.lifecycle-replay.release-names-blockers-adds-them-what: clause 2: a release that names blockers adds them to what the item waits on, so the final dependencies agree [C7]', () => {
  const facts = [
    fact('add', 20, 'coordinator', { after: '[]' }),
    fact('claim', 20, 'core-1', { leaseUntil: hour(60) }),
    fact('release', 20, 'core-1', { blockedOn: '[7,8]' }),
  ];
  const { items } = replay(facts);
  assert.deepEqual(items.get(20).after, [7, 8]);
  assert.equal(compareFinal(items, [{ id: 20, status: 'open', owner: null, held: false, after: [7, 8] }]).agreed, 1);
});

test('moves.lifecycle-replay.final-state-mismatch-names-item-last: clause 2: a final-state mismatch names the item and the last event that touched it [C7]', () => {
  const facts = [fact('add', 30, 'coordinator', { after: '[]' }), fact('claim', 30, 'core-1', { leaseUntil: hour(70) })];
  const { items } = replay(facts);
  const result = compareFinal(items, [{ id: 30, status: 'open', owner: null, held: false, after: [] }]);
  assert.equal(result.agreed, 0);
  assert.deepEqual(result.mismatches.map(m => [m.item, m.lastEvent, m.kind]), [[30, facts[1].id, 'final status: rules say claimed, board says open']]);
});
