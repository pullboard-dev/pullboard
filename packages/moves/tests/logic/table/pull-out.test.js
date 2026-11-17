/** Under sprint a red gate on landed, submitted work reopens it and queues its pull-out; a recorded revert ends the pull-out [M2,#8870]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PULLED_RULES } from '../../../index.js';
import { PULLED_TABLE } from '../../../index.js';
import { boardReopenEngine } from '../../../index.js';
import { landingOf } from '../../../index.js';
import { legalLanding } from '../../../index.js';
import { runTable } from '../../../index.js';

const { rules: RULES, table: TABLE } = boardReopenEngine();
const [COMMIT, MERGED, REVERT] = ['c'.repeat(40), 'e'.repeat(40), 'b'.repeat(40)];
const FAILURE = 'packages/a/tests/queue.test.js: keeps the queue whole; merge commit ' + MERGED;

/** A submitted item the lander has already merged, frozen at the given pace (none: steady), with a red gate result recorded on it. */
function landedRed(pace) {
  return { actor: { id: 'coordinator', joined: true },
    item: { id: 42, status: 'submitted', commit: COMMIT, mergedCommit: MERGED, builtBy: 'core-1', owner: 'core-1' },
    history: [{ kind: 'submit', detail: { commit: COMMIT } }, { kind: 'merged', detail: { commit: MERGED } }],
    landing: { accepted: undefined, failure: FAILURE }, conflict: {}, withdrawal: null, cause: null,
    ...(pace ? { pace } : {}) };
}
const RED = { id: 42, actor: 'coordinator', note: FAILURE };
const run = (table, rules, snapshot, move) => runTable(table, rules, structuredClone(snapshot), structuredClone(move));
/** The item's status and landing after a move, read the way the rules layer derives landing. */
const after = (s, out) => [out.patch.status ?? s.item.status, landingOf({ ...s.item, ...out.patch }, [...s.history, ...out.events])];

test('moves.pull-out.a-red-gate-result-on-a: clause 2: a red gate result on a submitted sprint item with landing landed writes a pull_out event and reopens it for its builder [M2,#8870]', () => {
  const s = landedRed('sprint');
  assert.equal(landingOf(s.item, s.history), 'landed');
  const out = run(TABLE, RULES, s, RED);
  assert.equal(out.refused, undefined, JSON.stringify(out.refused));
  assert.deepEqual(out.via, ['pull-out-red']);
  assert.deepEqual(out.events.map(e => e.kind), ['reopen', 'pull_out']);
  assert.equal(out.events[0].detail.landingFailure, FAILURE);
  assert.deepEqual(out.events[1], { kind: 'pull_out', by: 'coordinator', detail: { commit: COMMIT, mergedCommit: MERGED, builder: 'core-1', reason: 'GATE_RED', failure: FAILURE } });
  assert.deepEqual(out.patch, { status: 'open', verdict: null, verifiedBy: null, owner: null, leaseUntil: null, reviewBy: null, reviewUntil: null });
  assert.deepEqual(after(s, out), ['open', 'pulling']);
  assert.ok(legalLanding(...after(s, out)));
  // Steady is unchanged: the same red reopen is a plain submission return and queues nothing to pull out.
  const steady = run(TABLE, RULES, landedRed(null), RED);
  assert.deepEqual([steady.via, steady.events.map(e => e.kind)], [['return-submission'], ['reopen']]);
  // A sprint item not yet landed has nothing on main to pull out.
  const unlanded = landedRed('sprint');
  Object.assign(unlanded.item, { mergedCommit: null });
  unlanded.history.pop();
  assert.deepEqual(run(TABLE, RULES, unlanded, RED).via, ['return-submission']);
});

test('moves.pull-out.a-pulled-event-at-a-revert: clause 3: a pulled event at a revert commit moves the item\'s landing from pulling to none [M2,R3,#8870]', () => {
  const s = landedRed('sprint');
  const reopened = run(TABLE, RULES, s, RED);
  const pulling = { item: { ...s.item, ...reopened.patch }, history: [...s.history, ...reopened.events] };
  assert.equal(landingOf(pulling.item, pulling.history), 'pulling');
  const out = run(PULLED_TABLE, PULLED_RULES, pulling, { id: 42, actor: 'coordinator', revert: REVERT });
  assert.equal(out.refused, undefined, JSON.stringify(out.refused));
  assert.deepEqual(out.via, ['pulled']);
  assert.deepEqual(out.events, [{ kind: 'pulled', by: 'coordinator', detail: { commit: REVERT, reverted: MERGED } }]);
  assert.deepEqual(after(pulling, out), ['open', 'none']);
  assert.ok(legalLanding(...after(pulling, out)));
  // Landed again after the pull-out, the merged event reads landed once more.
  assert.equal(landingOf(pulling.item, [...pulling.history, ...out.events, { kind: 'merged' }]), 'landed');
  // Only a pull-out in progress takes a pulled record, only from the coordinator, and only with a full revert commit.
  const refused = (snapshot, move) => run(PULLED_TABLE, PULLED_RULES, snapshot, { id: 42, actor: 'coordinator', revert: REVERT, ...move }).refused?.code;
  assert.equal(refused({ ...pulling, history: [...pulling.history, ...out.events] }, {}), 'NOT_PULLING');
  assert.equal(refused(pulling, { actor: 'core-1' }), 'COORDINATOR_ONLY');
  assert.equal(refused(pulling, { revert: 'abc' }), 'REVERT_COMMIT');
});
