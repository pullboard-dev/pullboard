/**
 * @pullboard-test-boundary pure
 */
/** Observed value controls conversion priority; missing metrics remain unknown [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { testConversionPlan } from '../src/test-conversion.js';
import { capacitySummary, declaredTestBoundary, landedBatchCount } from '../src/capacity-summary.js';

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

test('conversion follows positive-catch value-report order before lower-value heavy work [C7]', () => {
  const input = report([row('valuable.test.js', 90_000, 2), row('second.test.js', 120_000, 1),
    row('costly.test.js', 900_000), row('unknown.test.js', null)]);
  const plan = testConversionPlan(input);
  assert.deepEqual(plan.order.map(entry => entry.file), ['valuable.test.js', 'second.test.js', 'costly.test.js']);
  assert.deepEqual(plan.unknown, ['unknown.test.js']);
  assert.equal(plan.removesTests, false);
  assert.ok(plan.order.every(entry => entry.requiresPersonApprovalForRemoval));
});

test('without recorded catches measured cost orders conversions, never missing time or unapproved deletion [C7]', () => {
  const slow = row('slow.test.js', null);
  slow.lastObservedRuntime = { durationMs: 300_000, source: 'native-single-file-receipt' };
  const plan = testConversionPlan(report([row('fast.test.js', 1000), slow, row('unknown.test.js', null)]));
  assert.deepEqual(plan.order.map(entry => entry.file), ['slow.test.js', 'fast.test.js']);
  assert.match(plan.basis, /measured-cost/u);
  assert.match(plan.order[0].proposal, /person before removal/u);
  assert.equal(plan.order[0].runtimeSource, 'native-single-file-receipt');
  assert.deepEqual(plan.unknown, ['unknown.test.js']);
});

test('capacity reports serial measured work, retries, landed batches and declared lower-bound share [C7]', () => {
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

test('partial timing and no landings keep all headline costs unknown with a known subtotal [C7]', () => {
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

test('landings use the first actual landed transition and declarations only come from leading comments [C7]', () => {
  const since = Date.parse('2026-10-13T00:00:00Z'), until = Date.parse('2026-10-27T00:00:00Z');
  assert.equal(landedBatchCount([landing('old', '2026-10-12T00:00:00Z'), landing('old', '2026-10-14T00:00:00Z'),
    landing('new', '2026-10-15T00:00:00Z')], since, until), 1);
  assert.equal(declaredTestBoundary('/**\n * @pullboard-test-boundary pure\n */\nimport x from "node:test";'), 'pure');
  assert.equal(declaredTestBoundary('const x = "@pullboard-test-boundary pure";'), 'unknown');
  assert.equal(declaredTestBoundary('/**\n * @pullboard-test-boundary pure\n * @pullboard-test-boundary contract\n */'), 'unknown');
});


test('untimed real catches remain unknown without claiming that no catches exist [C7]', () => {
  const plan = testConversionPlan(report([row('caught.test.js', null, 1), row('costly.test.js', 90_000)]));
  assert.match(plan.basis, /recorded catches lack timed conversion candidates/u);
  assert.deepEqual(plan.unknown, ['caught.test.js']);
  assert.deepEqual(plan.order.map(entry => entry.file), ['costly.test.js']);
  assert.equal(plan.removesTests, false);
});
