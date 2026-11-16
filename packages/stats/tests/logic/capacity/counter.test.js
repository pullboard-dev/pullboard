/** AFTER-only pure observer controls use synthetic native-shaped events, not authenticated moves or gate receipts [R1,R2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendCapacityCounter } from '../../../index.js';
import { emptyCapacityCounter } from '../../../index.js';
import { fitCapacity } from '../../../index.js';
import { planCapacity } from '../../../index.js';

const BASE = Date.parse('2026-10-24T00:00:00.000Z');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

/** Inject exact observation times without sleeping or creating physical CPU load. */
function at(hours) { return new Date(BASE + hours * 3_600_000).toISOString(); }

/** Model the observer's small persistent read/write port; deliberately no board scan API exists. */
function observer() {
  const cache = new Map([['capacity-summary', emptyCapacityCounter()]]);
  const reads = [];
  const writes = [];
  let sequence = 0;
  /** Return isolated decoded values, as SQLite projection records do. */
  function read(key) { reads.push(key); return cache.has(key) ? structuredClone(cache.get(key)) : null; }
  /** Persist an isolated projection value. */
  function write(key, value) { writes.push(key); cache.set(key, structuredClone(value)); }
  /** Feed an explicit immutable event fragment without pretending to execute the board's guards. */
  function apply(event) {
    appendCapacityCounter(event, JSON.parse(event.event_detail), Date.parse(event.event_at), read, write);
  }
  /** Construct actual event field names; actors here are fixture labels, not authenticated identities. */
  function send(kind, hour, item, detail = {}, by = 'builder') {
    const event = { event_id: ++sequence, event_at: at(hour), event_by: by,
      event_kind: kind, item_id: item, event_detail: JSON.stringify(detail) };
    apply(event);
    return event;
  }
  /** Select completed observations by semantic kind, not by their storage field order. */
  function samples(kind) {
    return [...cache].filter(([key, value]) => key.startsWith('capacity-sample:') && (!kind || value.kind === kind))
      .map(([, value]) => structuredClone(value));
  }
  return { cache, reads, writes, read, send, apply, samples };
}

/** A captured diff size binds the submitted head and its real measurement method. */
function submitted(commit, lines) {
  return { commit, submissionSize: { base: '0'.repeat(40), head: commit, lines, method: 'added-plus-deleted-no-renames' } };
}

/** Seed an ordinary recorded claim with explicit route and lease boundaries. */
function claimed(box, id = 1) {
  box.send('add', 0, id, { lane: 'core', route: 'strong', after: [] }, 'coordinator');
  box.send('claim', 1, id, { leaseUntil: at(20) });
}

/** A separate completed source-head episode supplies a measured zero-return cohort, not batch timing. */
function successfulOutcome() {
  const box = observer();
  claimed(box, 99);
  box.send('submit', 2, 99, submitted(A, 100));
  box.send('accept', 3, 99, { commit: A }, 'reviewer');
  box.send('merged', 4, 99, { commit: C }, 'coordinator');
  return box.samples('landingOutcome');
}

test('capacity observer measures each build attempt and one whole cycle through reject and reclaim [R1,R2]', () => {
  const box = observer();
  claimed(box);
  box.send('submit', 3, 1, submitted(A, 99));
  box.send('reserve', 4, 1, { until: at(12) }, 'reviewer');
  box.send('reject', 5, 1, { commit: A, reason: 'BEHAVIOR_MISMATCH' }, 'reviewer');
  box.send('claim', 7, 1, { leaseUntil: at(20) });
  box.send('submit', 8, 1, submitted(B, 300));
  box.send('reserve', 9, 1, { until: at(12) }, 'reviewer');
  box.send('accept', 10, 1, { commit: B }, 'reviewer');
  assert.deepEqual(box.samples('build').map(row => row.hours), [2, 1], 'rework starts at the second claim, not the original claim');
  assert.deepEqual(box.samples('reworkGap').map(row => row.hours), [2]);
  assert.deepEqual(box.samples('cycle').map(row => row.hours), [9], 'the whole first-claim-to-accept cycle includes the idle rework gap once');
  assert.deepEqual(box.samples('decision').map(row => row.accepted), [false, true]);
  box.send('landing_batch', 11, null, { batch: { id: 'completed', state: 'trunk', startedAt: at(10), updatedAt: at(11), items: [{ id: 1 }] } }, 'coordinator');
  const fit = fitCapacity([...box.samples(), ...successfulOutcome()], { from: at(0), to: at(24) });
  const planner = planCapacity({ items: [{ id: 2, route: 'strong', state: 'open', after: [], files: ['src/new.js'], held: false, needsYou: false }],
    fit, liveSeats: 2, now: at(24), sequence: box.read('capacity-summary').last, seed: 3, simulate: false });
  assert.equal(planner.workHours, 5, 'mean active build1.5h plus review1h, repeated at measured reject probability.5');
  assert.equal(planner.bounds.criticalPathHours, 9);
  assert.equal(planner.bounds.stragglerHours, 9, 'observed cycle is not multiplied for rework again');
  box.send('reopen', 12, 1, { commit: B, conflict: { main: C } }, 'coordinator');
  box.send('claim', 13, 1, { leaseUntil: at(20) });
  box.send('submit', 14, 1, submitted(C, 400));
  box.send('reserve', 15, 1, { until: at(18) }, 'reviewer');
  box.send('accept', 16, 1, { commit: C }, 'reviewer');
  assert.deepEqual(box.samples('cycle').map(row => row.hours), [9], 'a later landing return cannot rewrite or duplicate the first acceptance cycle');
});

test('capacity review measurements require the matching submission and a live same-actor reservation [R1,R2]', () => {
  for (const scenario of ['valid', 'wrong commit', 'wrong actor', 'expired', 'released']) {
    const box = observer();
    claimed(box);
    box.send('submit', 2, 1, submitted(A, 100));
    box.send('reserve', 3, 1, { until: at(scenario === 'expired' ? 4 : 5) }, 'reviewer');
    if (scenario === 'released') box.send('release', 3.5, 1, { review: true, reason: 'handoff' }, 'reviewer');
    box.send('accept', 5, 1, { commit: scenario === 'wrong commit' ? B : A }, scenario === 'wrong actor' ? 'other-reviewer' : 'reviewer');
    assert.deepEqual(box.samples('review').map(row => row.hours), scenario === 'wrong commit' ? [] : [scenario === 'valid' ? 2 : null], scenario);
    assert.deepEqual(box.samples('decision').map(row => row.accepted), scenario === 'wrong commit' ? [] : [true],
      'recorded matching outcomes remain distinct from unmeasurable reviewer labor');
  }
});

test('capacity missing history stays unknown and an item fact preserves claim-expiry accounting [R1,R2]', () => {
  const fragment = observer();
  fragment.send('submit', 2, 1, submitted(A, 100));
  fragment.send('accept', 4, 1, { commit: A }, 'reviewer');
  assert.deepEqual(fragment.samples('build').map(row => row.hours), [null]);
  assert.deepEqual(fragment.samples('review').map(row => row.hours), [null]);
  assert.deepEqual(fragment.samples('reviewWait').map(row => row.hours), [null]);
  assert.deepEqual(fragment.samples('cycle').map(row => row.hours), [null]);
  const box = observer();
  box.send('add', 0, 1, { lane: 'core', route: 'strong', after: [] }, 'coordinator');
  box.send('claim', 1, 1, { leaseUntil: at(2) });
  box.send('fact', 3, 1, { kind: 'note', text: 'after expiry' });
  box.send('claim', 5, 1, { leaseUntil: at(10) });
  box.send('submit', 6, 1, submitted(A, 100));
  assert.deepEqual(box.samples('reworkGap').map(row => row.hours), [3], 'the idle interval starts at recorded expiry, not the later fact');
  assert.deepEqual(box.samples('build').map(row => row.hours), [1], 'expired build time cannot leak into the new attempt');
  assert.equal(box.samples('reworkGap').length, 1, 'the first claim did not manufacture a zero gap');
});

test('capacity terminal batches deduplicate trunk to landed and retain missing cycle boundaries [R1,R2]', () => {
  const box = observer();
  const batch = { id: 'batch', startedAt: at(2), items: [{ id: 1 }, { id: 2 }] };
  box.send('landing_batch', 3, null, { batch: { ...batch, state: 'merging', updatedAt: at(3) } }, 'coordinator');
  assert.equal(box.samples('landing').length, 0);
  box.send('landing_batch', 4, null, { batch: { ...batch, state: 'trunk', updatedAt: at(4) } }, 'coordinator');
  box.send('landing_batch', 8, null, { batch: { ...batch, state: 'landed', updatedAt: at(8) } }, 'coordinator');
  assert.deepEqual(box.samples('landing').map(row => [row.hours, row.batchSize]), [[2, 2]], 'publication is not a second cycle or six extra hours of service');
  box.send('landing_batch', 9, null, { batch: { id: 'legacy', state: 'landed', updatedAt: at(9), items: [{ id: 3 }] } }, 'coordinator');
  assert.deepEqual(box.samples('landing').map(row => row.hours), [2, null]);
  const fit = fitCapacity([...box.samples(), ...successfulOutcome()], { from: at(0), to: at(24) });
  const planner = planCapacity({ items: [1, 2].map(id => ({ id, route: 'strong', state: 'accepted', after: [], files: [], held: false, needsYou: false })),
    fit, liveSeats: 0, now: at(24), sequence: 4, seed: 1, simulate: false });
  assert.equal(planner.bounds.landingHours, 2, 'two accepted items use one measured two-member coordinator batch cycle');
});

test('capacity approval observations require ordered native authority and support prototype-like row IDs [R1,R2]', () => {
  const box = observer();
  box.send('spec_approval_baseline', 0, null, { rows: [{ id: 'untrusted' }] }, 'builder');
  assert.equal(box.read('capacity-approvals'), null);
  box.send('spec_approval_baseline', 1, null, { rows: [{ id: 'G1' }, { id: '__proto__' }, { id: 'constructor' }] }, 'coordinator');
  box.send('row_decision', 2, null, { record: { kind: 'spec', id: 'G1', decision: 'decline' } }, 'person');
  box.send('row_decision', 3, null, { record: { kind: 'spec', id: 'G1', decision: 'approve' } }, 'builder');
  box.send('row_decision', 4, null, { record: { kind: 'doctrine', id: 'G1', decision: 'approve' } }, 'person');
  box.send('row_decision', 5, null, { record: { kind: 'spec', id: '__proto__', decision: 'decline' } }, 'person');
  const rows = box.read('capacity-approvals').rows;
  assert.equal(rows.G1, false, 'an agent or a different row namespace cannot replace the person decision');
  assert.ok(Object.hasOwn(rows, '__proto__'));
  assert.equal(rows.__proto__, false);
  assert.ok(Object.hasOwn(rows, 'constructor'));
  assert.equal(rows.constructor, true);
  assert.equal(Object.hasOwn(Object.prototype, 'G1'), false);
});

test('capacity cursor replay is idempotent and irrelevant null-item shouts touch no item or policy map [R1,R2]', () => {
  const box = observer();
  claimed(box);
  const event = box.send('submit', 2, 1, submitted(A, 100));
  const snapshot = structuredClone(box.cache);
  box.apply(event);
  assert.deepEqual(box.cache, snapshot, 'repeated delivery cannot duplicate samples or rewind lifecycle');
  box.reads.length = 0;
  box.writes.length = 0;
  box.send('shout', 3, null, { to: 'all', text: 'ordinary coordination' });
  assert.deepEqual(box.reads, ['capacity-summary']);
  assert.deepEqual(box.writes, ['capacity-summary']);
  assert.equal(box.read('capacity-summary').last, event.event_id + 1);
});


// Completed outcome authority is distinct from gate timing and duplicate receipts.
test('landing outcomes match accepted source episodes and deduplicate returns and merge receipts [R1,R2]', () => {
  const box = observer();
  claimed(box);
  box.send('submit', 2, 1, submitted(A, 100));
  box.send('accept', 3, 1, { commit: A }, 'reviewer');
  box.send('accept', 3.5, 1, { commit: A }, 'reviewer');
  box.send('reopen', 4, 1, { commit: A, landingFailure: { reason: 'typed authority' }, note: 'the human wording says conflict' }, 'coordinator');
  box.send('reopen', 4.5, 1, { commit: A, conflict: {} }, 'coordinator');
  assert.deepEqual(box.samples('landingOutcome').map(row => [row.sourceCommit, row.failed, row.cause]), [[A, true, 'landing-test']]);
  box.send('claim', 5, 1, { leaseUntil: at(20) });
  box.send('submit', 6, 1, submitted(B, 100));
  box.send('accept', 7, 1, { commit: B }, 'reviewer');
  box.send('merged', 8, 1, { commit: C }, 'coordinator');
  box.send('merged', 9, 1, { commit: C }, 'coordinator');
  assert.deepEqual(box.samples('landingOutcome').map(row => [row.sourceCommit, row.failed, row.cause]), [[A, true, 'landing-test'], [B, false, 'merged']]);
  assert.equal(box.samples('landing').length, 0, 'outcome probability does not invent a batch-cycle duration');
  const wrong = observer();
  claimed(wrong);
  wrong.send('submit', 2, 1, submitted(A, 100));
  wrong.send('accept', 3, 1, { commit: A }, 'reviewer');
  wrong.send('reopen', 4, 1, { commit: B, conflict: {} }, 'coordinator');
  assert.deepEqual(wrong.samples('landingOutcome').map(row => row.failed), [null], 'a return for another source head is unknown coverage, never an observed failure or success');
});


test('unclassified accepted exits are right-censored: kept as unknown coverage and dropped from the rate [R1,R2]', () => {
  for (const kind of ['reopen', 'refreeze', 'escalate', 'withdraw']) {
    const box = observer();
    claimed(box);
    box.send('submit', 2, 1, submitted(A, 100));
    box.send('accept', 3, 1, { commit: A }, 'reviewer');
    box.send(kind, 4, 1, { commit: A }, 'coordinator');
    assert.deepEqual(box.samples('landingOutcome').map(row => row.failed), [null], kind);
    const fitted = fitCapacity([...box.samples(), ...successfulOutcome()], { from: at(0), to: at(24) });
    assert.equal(fitted.routes[0].landingRisk.unknown, 1, 'the censored exit stays visible as unknown coverage');
    assert.equal(fitted.routes[0].landingRisk.probability, 0, 'the rate counts only classified outcomes');
  }
  const stale = observer();
  claimed(stale);
  stale.send('submit', 2, 1, submitted(A, 100));
  stale.send('accept', 3, 1, { commit: A }, 'reviewer');
  stale.send('reopen', 4, 1, { commit: A, cause: 'refusal:REOPENED', causeDerivation: { kind: 'reopen-category', coarse: true } }, 'coordinator');
  assert.deepEqual(stale.samples('landingOutcome').map(row => [row.failed, row.cause]), [[true, 'stale']], 'a categorised coordinator reopen is a typed stale return');
  const pending = observer();
  claimed(pending);
  pending.send('submit', 2, 1, submitted(A, 100));
  pending.send('accept', 3, 1, { commit: A }, 'reviewer');
  assert.deepEqual(pending.samples('landingOutcome'), [], 'a still-open accepted episode has no invented terminal outcome');
});
