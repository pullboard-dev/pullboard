/** Under sprint a landed item still takes its verdict: an accept ends verified and landed, a reject queues its pull-out; steady keeps ALREADY_MERGED [V6,#8868]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardVerifyEngine } from '../../../index.js';
import { landingOf } from '../../../index.js';
import { legalLanding } from '../../../index.js';
import { runTable } from '../../../index.js';

const { rules: RULES, table: TABLE } = boardVerifyEngine();
const [COMMIT, MERGED, TRUNK, DIGEST] = ['c'.repeat(40), 'e'.repeat(40), 'a'.repeat(40), 'd'.repeat(64)];
const FROZEN = JSON.stringify({ criterion: '1. Alpha keeps the queue whole [test]. 2. Beta names every refusal [test].',
  policy: { version: 1, commit: 'f'.repeat(40), verify: { policy: 'any', family: 'off' } } });

/** A submitted item the lander has already merged, frozen at the given pace (none: steady), reviewed by a seat that never built it. */
function landed(pace, extra = {}) {
  return { now: '2026-11-16T12:00:00.000Z', actor: { id: 'core-7', joined: true, route: 'strong', family: null },
    item: { id: 42, status: 'submitted', merged: true, mergedCommit: MERGED, commit: COMMIT, frozenDigest: DIGEST, frozen: FROZEN, route: 'light', lane: 'core',
      builtBy: 'core-1', owner: 'core-1', reviewBy: null, reviewUntil: null, effectiveHead: null, outside: null },
    history: [{ id: 1, kind: 'submit', by: 'core-1', detail: { commit: COMMIT } }, { id: 2, kind: 'merged', by: 'coordinator', detail: { commit: MERGED } }],
    verdicts: [], knownItems: [], actorFlakeObservations: [], nativeFlakeEngine: 61, lineSettings: { sharpenToPerson: false }, nextEventId: 10, nextVerdictId: 5,
    io: { isMain: false, mainRefusal: null, selfSession: false, staleAcceptance: false, policyRefused: null, commitInHead: true, root: '/repo', missingCompanions: null,
      checkRefused: null, selectorGap: false, reviewHolderFresh: false },
    deferred: { environmentProblem: null, knownMainProblem: null, quarantineProblem: null, gateReceipt: null, companionWindow: null, authorProblem: null, requiredFamily: null,
      familyProblem: null, patchProblem: null, sandboxProblem: null, relaxation: null, assurance: null, impliedFacts: null },
    ...(pace ? { pace } : {}), ...extra };
}
const review = { commit: COMMIT, head: COMMIT, trunk: TRUNK, paths: ['a.js'] };
const ACCEPT = { id: 42, actor: 'core-7', decision: 'ACCEPT', note: 'broke the queue order; the check went red', head: COMMIT, digest: DIGEST, review };
const REJECT = { id: 42, actor: 'core-7', decision: 'REJECT', reason: 'BEHAVIOR_MISMATCH', note: 'the queue drops a waiter', clause: 'Alpha keeps', head: COMMIT, digest: DIGEST, review };
const run = (snapshot, move) => runTable(TABLE, RULES, structuredClone(snapshot), structuredClone(move));
/** The item's status and landing after a move, read the way the rules layer derives landing. */
const after = (s, out) => [out.patch.status, landingOf({ ...s.item, ...out.patch }, [...s.history, ...out.events])];

test('moves.verify-sprint.a-submitted-sprint-item-with-landing-landed: clause 1: a submitted sprint item with landing landed is accepted by the verify table, ending verified with landing landed [V6,#8868]', () => {
  const s = landed('sprint');
  assert.equal(landingOf(s.item, s.history), 'landed');
  const out = run(s, ACCEPT);
  assert.equal(out.refused, undefined, JSON.stringify(out.refused));
  assert.deepEqual(out.via, ['accept']);
  assert.deepEqual(out.events.map(e => e.kind), ['accept']);
  assert.deepEqual(after(s, out), ['verified', 'landed']);
  assert.ok(legalLanding(...after(s, out)));
});

test('moves.verify-sprint.a-reject-of-that-item-writes-a: clause 2: a reject of that item writes a pull_out event, leaving it open with landing pulling for its builder [V6,M2,#8868]', () => {
  const s = landed('sprint');
  const out = run(s, REJECT);
  assert.equal(out.refused, undefined, JSON.stringify(out.refused));
  assert.deepEqual(out.via, ['reject', 'pull-out']);
  assert.deepEqual(out.events.map(e => e.kind), ['reject', 'pull_out']);
  assert.deepEqual(out.events[1], { kind: 'pull_out', by: 'coordinator', detail: { commit: COMMIT, mergedCommit: MERGED, builder: 'core-1', verdict: 5, reason: 'BEHAVIOR_MISMATCH' } });
  assert.deepEqual(after(s, out), ['open', 'pulling']);
  assert.ok(legalLanding(...after(s, out)));
  // A sprint reject of work not yet landed queues nothing to pull out.
  const unlanded = landed('sprint');
  Object.assign(unlanded.item, { merged: false, mergedCommit: null });
  unlanded.history.pop();
  const plain = run(unlanded, REJECT);
  assert.deepEqual([plain.via, plain.events.map(e => e.kind), after(unlanded, plain)], [['reject'], ['reject'], ['open', 'none']]);
});

test('moves.verify-sprint.under-sprint-a-published-item-or-one: clause 2: under sprint a published item, or one already pulling, takes no verdict, and its refusal names why [V6,#8868]', () => {
  const published = landed('sprint');
  published.history.push({ id: 3, kind: 'published', by: 'coordinator', detail: {} });
  const refused = run(published, ACCEPT).refused;
  assert.deepEqual([refused.code, refused.row], ['ALREADY_MERGED', 'sprint-not-final']);
  assert.match(refused.message, /^item #42 is published;/u);
  // The landing a pull_out leaves is pulling, and nothing but its own events moves it.
  const pulling = landed('sprint');
  pulling.history.push({ id: 3, kind: 'pull_out', by: 'coordinator', detail: {} });
  assert.equal(landingOf(pulling.item, pulling.history), 'pulling');
  assert.equal(landingOf(pulling.item), 'landed', 'without its history the merged commit alone still reads landed');
});

test('moves.verify-sprint.a-landed-steady-item-and-a-landed: clause 3: a landed steady item, and a landed strict one, are still refused with ALREADY_MERGED at not-merged [V6,#8868]', () => {
  for (const pace of [undefined, 'steady', 'strict']) {
    const refused = run(landed(pace), ACCEPT).refused;
    assert.deepEqual([refused?.code, refused?.row], ['ALREADY_MERGED', 'not-merged'], String(pace));
    assert.equal(run(landed(pace), REJECT).refused?.code, 'ALREADY_MERGED', String(pace));
  }
  const steadyRows = (rows) => rows.filter(row => !row.paces || row.paces.includes('steady')).map(row => row.id);
  assert.ok(!steadyRows(TABLE.guards).includes('sprint-not-final') && !steadyRows(TABLE.followups).includes('pull-out'), 'steady holds no sprint row');
});

/** A submitted item its builder accepts on its own: one low-stakes row frozen and approved, one check a machine ran red then green, and the tree the event binds. */
const TREE = 'b'.repeat(40);
const SOLO_FROZEN = JSON.stringify({ ...JSON.parse(FROZEN), rows: [{ id: 'r1', stakes: 'low' }] });
const solo = (extra = {}) => {
  const s = landed(null, { soloLowStakes: true, rows: [{ id: 'r1', stakes: 'low', personApproved: true }],
    checks: [{ machineRun: true, redBefore: true, greenAfter: true }], ...extra });
  Object.assign(s.item, { merged: false, mergedCommit: null, frozen: SOLO_FROZEN, tree: TREE });
  s.history.pop();
  s.actor = { ...s.actor, id: 'core-1' };
  return s;
};
const BUILDER_ACCEPT = { ...ACCEPT, actor: 'core-1' };

test('moves.table-verify.solo-accept-event: clause 1: a builder accept with every solo condition holding is admitted and followed by one solo-low-stakes-accept event binding verdict, commit, tree, digest and by [C7]', () => {
  const s = solo();
  const out = run(s, BUILDER_ACCEPT);
  assert.equal(out.refused, undefined);
  assert.deepEqual(out.events.map(e => e.kind), ['accept', 'solo-low-stakes-accept']);
  assert.deepEqual(out.events[1].detail, { verdict: 5, commit: COMMIT, tree: TREE, digest: DIGEST, by: 'core-1' });
  assert.equal(out.patch.verdictRow.id, out.events[1].detail.verdict);
});

test('moves.table-verify.no-solo-event-independent: clause 2: an independent accept writes no solo-low-stakes-accept event, and a builder accept where a solo condition fails is refused SELF_VERIFY with no events [C7]', () => {
  const independent = run(solo(), ACCEPT);
  assert.equal(independent.refused, undefined);
  assert.deepEqual(independent.events.map(e => e.kind), ['accept']);
  const failing = {
    'setting off': solo({ soloLowStakes: false }),
    'a team row': solo({ rows: [{ id: 'r1', stakes: 'team', personApproved: true }] }),
    'a row not approved': solo({ rows: [{ id: 'r1', stakes: 'low', personApproved: false }] }),
    'a check not run red then green': solo({ checks: [{ machineRun: true, redBefore: false, greenAfter: true }] }),
    'no tree': Object.assign(solo(), { item: { ...solo().item, tree: null } }),
  };
  for (const [name, s] of Object.entries(failing)) {
    const out = run(s, BUILDER_ACCEPT);
    assert.equal(out.refused?.code, 'SELF_VERIFY', name);
    assert.deepEqual(out.events ?? [], [], name);
  }
});
