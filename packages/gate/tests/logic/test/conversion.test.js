/**
 * @pullboard-test-boundary pure
 */
/** Observed value controls conversion priority; missing metrics remain unknown [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testConversionPlan } from '../../../index.js';
import { capacitySummary } from '../../../index.js';
import { declaredTestBoundary } from '../../../index.js';
import { landedBatchCount } from '../../../index.js';

/** Build an input report, never a gate receipt or authority witness. */
function report(files = []) {
  return { since: '2026-10-13T00:00:00Z', asOf: '2026-10-27T00:00:00Z', files,
    coverage: { unknownFileReceipts: 0, receipts: 2 } };
}

/** Describe independent measured observations; unknown duration has no fabricated fallback. */
function row(file, runtime, catches = 0) {
  return { file, runs: 2, realCatches: catches, meanRuntimeMs: runtime,
    runtimeMs: runtime === null ? null : runtime * 2, timedRuns: runtime === null ? 0 : 2,
    lastObservedRuntime: null, valuePerRun: null };
}

/** Native append-only event fixtures exercise first transition counting, not synthetic gate success. */
function landing(id, at) {
  return { event_kind: 'landing_batch', event_at: at,
    event_detail: JSON.stringify({ batch: { id, state: 'landed' } }) };
}

test('gate.logic-test-conversion.conversion-follows-positive-catch-value: conversion follows positive-catch value-report order before lower-value heavy work [C7]', () => {
  const input = report([row('valuable.test.js', 90_000, 2), row('second.test.js', 120_000, 1),
    row('costly.test.js', 900_000), row('unknown.test.js', null)]);
  const plan = testConversionPlan(input);
  assert.deepEqual(plan.order.map(entry => entry.file), ['valuable.test.js', 'second.test.js', 'costly.test.js']);
  assert.deepEqual(plan.unknown, ['unknown.test.js']);
  assert.equal(plan.removesTests, false);
  assert.ok(plan.order.every(entry => entry.requiresPersonApprovalForRemoval));
});

test('gate.logic-test-conversion.without-recorded-catches-measured-cost: without recorded catches measured cost orders conversions, never missing time or unapproved deletion [C7]', () => {
  const slow = row('slow.test.js', null);
  slow.lastObservedRuntime = { durationMs: 300_000, source: 'native-single-file-receipt' };
  const plan = testConversionPlan(report([row('fast.test.js', 1000), slow, row('unknown.test.js', null)]));
  assert.deepEqual(plan.order.map(entry => entry.file), ['slow.test.js', 'fast.test.js']);
  assert.match(plan.basis, /measured-cost/u);
  assert.match(plan.order[0].proposal, /person before removal/u);
  assert.equal(plan.order[0].runtimeSource, 'native-single-file-receipt');
  assert.deepEqual(plan.unknown, ['unknown.test.js']);
});

test('gate.logic-test-conversion.capacity-reports-serial-measured-work: capacity reports serial measured work, retries, landed batches and declared lower-bound share [C7]', () => {
  const history = [landing('a', '2026-10-14T00:00:00Z'), landing('a', '2026-10-15T00:00:00Z'),
    landing('b', '2026-10-16T00:00:00Z')];
  const input = report([row('a.test.js', 60_000), row('b.test.js', 120_000)]);
  const audit = { id: 'audit', head: 'source', green: false, collection: { files: ['a.test.js', 'b.test.js'] } };
  const output = capacitySummary({ value: input, history, latestAudit: audit,
    timings: { files: [{ file: 'a.test.js', durationMs: 60_000 }, { file: 'a.test.js', durationMs: 30_000 },
      { file: 'b.test.js', durationMs: 120_000 }] },
    inventory: [{ kind: 'pure' }, { kind: 'contract' }, { kind: 'unknown' }, { kind: 'unknown' }] });
  assert.equal(output.suite.minutes, 3.5, 'retry execution work is included, not parallel elapsed wall time');
  assert.equal(output.suite.green, false, 'complete red work is still measured red work');
  assert.equal(output.perLanding.knownMinutes, 6);
  assert.equal(output.perLanding.landings, 2);
  assert.equal(output.perLanding.minutes, 3);
  assert.deepEqual(output.files, { total: 4, pure: 1, contract: 1, unknown: 2, share: 0.5,
    lowerBound: true, measure: 'explicit committed pure/contract declarations; undeclared files remain unknown' });
  assert.match(output.suite.measure, /not elapsed parallel wall time/u);
});

test('gate.logic-test-conversion.partial-timing-and-no-landings: partial timing and no landings keep all headline costs unknown with a known subtotal [C7]', () => {
  const value = report([row('measured.test.js', 60_000), row('missing.test.js', null)]);
  const output = capacitySummary({ value, history: [], inventory: [],
    latestAudit: { id: 'audit', head: 'source', green: true, collection: { files: ['measured.test.js', 'missing.test.js'] } },
    timings: { files: [{ file: 'measured.test.js', durationMs: 60_000 }] } });
  assert.equal(output.suite.minutes, null);
  assert.equal(output.suite.knownMinutes, 1);
  assert.deepEqual(output.suite.missingFiles, ['missing.test.js']);
  assert.equal(output.perLanding.minutes, null);
  assert.equal(output.perLanding.knownMinutes, 2);
  assert.equal(output.perLanding.missingExecutions, 2);
  assert.equal(output.files.share, null);
  const absent = capacitySummary({ value: report(), history: [], inventory: [], latestAudit: null, timings: null });
  assert.equal(absent.suite.minutes, null);
  assert.equal(absent.suite.knownMinutes, null);
  assert.equal(absent.perLanding.minutes, null);
});

test('gate.logic-test-conversion.landings-use-the-first-actual: landings use the first actual landed transition and declarations only come from leading comments [C7]', () => {
  const since = Date.parse('2026-10-13T00:00:00Z'), until = Date.parse('2026-10-27T00:00:00Z');
  assert.equal(landedBatchCount([landing('old', '2026-10-12T00:00:00Z'), landing('old', '2026-10-14T00:00:00Z'),
    landing('new', '2026-10-15T00:00:00Z')], since, until), 1);
  assert.equal(declaredTestBoundary('/**\n * @pullboard-test-boundary pure\n */\nimport x from "node:test";'), 'pure');
  assert.equal(declaredTestBoundary('const x = "@pullboard-test-boundary pure";'), 'unknown');
  assert.equal(declaredTestBoundary('/**\n * @pullboard-test-boundary pure\n * @pullboard-test-boundary contract\n */'), 'unknown');
});


test('gate.logic-test-conversion.untimed-real-catches-remain-unknown: untimed real catches remain unknown without claiming that no catches exist [C7]', () => {
  const plan = testConversionPlan(report([row('caught.test.js', null, 1), row('costly.test.js', 90_000)]));
  assert.match(plan.basis, /recorded catches lack timed conversion candidates/u);
  assert.deepEqual(plan.unknown, ['caught.test.js']);
  assert.deepEqual(plan.order.map(entry => entry.file), ['costly.test.js']);
  assert.equal(plan.removesTests, false);
});

/** Describe an actual native event shape without lending it gate authority. */
function nativeEvent(kind, at, detail, item = null) {
  return { event_kind: kind, event_at: at, item_id: item, event_detail: JSON.stringify(detail) };
}

test('gate.logic-test-conversion.capacity-counts-actual-merged-history: capacity counts actual merged history and groups explicit successful train receipts, never unfinished snapshots [C7]', () => {
  const since = Date.parse('2026-10-13T00:00:00Z'), until = Date.parse('2026-10-27T00:00:00Z');
  const old = 'a'.repeat(40), first = 'b'.repeat(40), second = 'c'.repeat(40), third = 'd'.repeat(40);
  const history = [nativeEvent('merged', '2026-10-12T00:00:00Z', { commit: old }, 1),
    nativeEvent('merged', '2026-10-14T00:00:00Z', { commit: old }, 1),
    nativeEvent('merged', '2026-10-15T00:00:00Z', { commit: first }, 2),
    nativeEvent('merged', '2026-10-15T00:00:01Z', { commit: first }, 3),
    nativeEvent('landing_batch', '2026-10-16T00:00:00Z', { batch: { id: 'incomplete', state: 'merging', tip: third } }),
    nativeEvent('merged', '2026-10-17T00:00:00Z', { commit: second }, 4),
    nativeEvent('merged', '2026-10-17T00:00:01Z', { commit: third }, 5),
    nativeEvent('main-moved', '2026-10-17T00:00:02Z', { sha: third, batch: 'real-train', items: [4, 5] }),
    nativeEvent('landing_batch', '2026-10-17T00:00:03Z', { batch: { id: 'real-train', state: 'landed', tip: third,
      items: [{ id: 4, merge: second }, { id: 5, merge: third }] } })];
  assert.equal(landedBatchCount(history, since, until), 2,
    'one manual merge plus one explicit train, excluding old first landings and unfinished snapshots');
  assert.equal(landedBatchCount(history.filter(event => event.event_kind !== 'landing_batch'), since, until), 2,
    'main-moved alone groups the actual preceding per-item merge receipts');
  assert.equal(landedBatchCount(history.filter(event => event.event_kind !== 'main-moved'), since, until), 2,
    'the landed snapshot groups every item merge, not only its final tip');
  assert.equal(landedBatchCount([...history, history.at(-2), history.at(-1)], since, until), 2,
    'repeated successful receipts cannot create another landing');
  assert.equal(landedBatchCount(history.filter(event => event.event_kind === 'merged'), since, until), 3,
    'the real board legacy/manual path needs no landed snapshot to count three distinct new merge commits');
  assert.equal(landedBatchCount(history.filter(event => event.event_kind === 'landing_batch' && JSON.parse(event.event_detail).batch.state !== 'landed'), since, until), 0);
});

test('gate.logic-test-conversion.unknown-suite-measurement-identifies-the: unknown suite measurement identifies the required complete audit receipt and missing file timings [C7]', () => {
  const absent = capacitySummary({ value: report(), history: [], inventory: [], latestAudit: null, timings: null });
  assert.equal(absent.suite.minutes, null);
  assert.match(absent.suite.unavailableReason, /complete.*full.*native.*audit.*receipt/iu);
  const partial = capacitySummary({ value: report(), history: [], inventory: [],
    latestAudit: { id: 'audit', head: 'source', green: false, collection: { files: ['a.test.js'] } }, timings: null });
  assert.equal(partial.suite.minutes, null);
  assert.match(partial.suite.unavailableReason, /audit.*per-file.*timing/iu);
  assert.deepEqual(partial.suite.missingFiles, ['a.test.js']);
});

test('gate.logic-test-conversion.explicit-batch-cost-belongs-to: explicit batch cost belongs to its first success, while manual commits retain their first landing [C7]', () => {
  const since = Date.parse('2026-10-13T00:00:00Z'), until = Date.parse('2026-10-27T00:00:00Z');
  const old = 'e'.repeat(40), fresh = 'f'.repeat(40);
  const history = [nativeEvent('merged', '2026-10-12T23:59:59Z', { commit: old }, 11),
    nativeEvent('merged', '2026-10-14T00:00:00Z', { commit: fresh }, 12),
    nativeEvent('main-moved', '2026-10-14T00:00:01Z', { sha: fresh, batch: 'boundary', items: [11, 12] })];
  assert.equal(landedBatchCount(history, since, until), 1, 'the successful explicit batch is in the window');
  const firstSuccessBefore = [...history.slice(0, 1),
    nativeEvent('main-moved', '2026-10-12T23:59:59Z', { sha: old, batch: 'old-success', items: [11] }),
    nativeEvent('main-moved', '2026-10-14T00:00:01Z', { sha: old, batch: 'old-success', items: [11] })];
  assert.equal(landedBatchCount(firstSuccessBefore, since, until), 0, 'a repeated old batch success is not new');
});
