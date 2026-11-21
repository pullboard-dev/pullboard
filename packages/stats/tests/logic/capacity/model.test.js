/** Deterministic empirical fixtures separate observed labor, waiting and unknown capacity [R1,R2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { capacityLines } from '../../../index.js';
import { fitCapacity } from '../../../index.js';
import { planCapacity } from '../../../index.js';

const NOW = '2026-10-25T00:00:00.000Z';
const FROM = '2026-10-01T00:00:00.000Z';
const AT = '2026-10-24T00:00:00.000Z';

/** Construct measured route service and explicit landing outcomes without hidden fallback inputs. */
function samples({ build = 2, review = 1, wait = 4, gap = 3, reject = false, landing = 0.25, cycle = 7 } = {}) {
  return [
    { at: AT, kind: 'build', route: 'strong', size: 100, attempt: 'first', hours: build },
    { at: AT, kind: 'review', route: 'strong', size: 100, attempt: 'first', hours: review },
    { at: AT, kind: 'reviewWait', route: 'strong', size: 100, attempt: 'first', hours: wait },
    { at: AT, kind: 'reworkGap', route: 'strong', size: 100, attempt: 'reject', hours: gap },
    { at: AT, kind: 'cycle', route: 'strong', size: 100, attempt: 'unknown', hours: cycle },
    { at: AT, kind: 'decision', route: 'strong', size: 100, attempt: 'first', accepted: true },
    ...(reject ? [{ at: AT, kind: 'decision', route: 'strong', size: 100, attempt: 'reject', accepted: false }] : []),
    { at: AT, kind: 'landing', hours: landing, batchSize: 1, failed: 0 },
    { at: AT, kind: 'landingOutcome', route: 'strong', sourceCommit: 'a'.repeat(40), acceptEvent: 1, failed: false, cause: 'merged' },
  ];
}
/** Keep item metadata explicit so a missing path list is never called collision-free. */
function item(id, extra = {}) { return { id, route: 'strong', state: 'open', after: [], files: [`src/${id}.js`], held: false, needsYou: false, ...extra }; }
/** Fit the same immutable observation window for each independent model control. */
function fit(rows = samples()) { return fitCapacity(rows, { from: FROM, to: NOW }); }
/** Project a deterministic seed and explicit live staffing. */
function plan(items, fitted = fit(), extra = {}) { return planCapacity({ items, fit: fitted, liveSeats: 4, now: NOW, sequence: 17, seed: 39, ...extra }); }

test('stats.model.capacity-fits-use-only-seven-day: capacity fits use only seven-day measured samples and retain zero versus unknown [R1,R2]', () => {
  const fitted = fit([...samples(),
    { at: '2026-10-17T23:59:59.999Z', kind: 'build', route: 'strong', hours: 900 },
    { at: '2026-10-26T00:00:00.000Z', kind: 'build', route: 'strong', hours: 900 },
    { at: AT, kind: 'build', route: 'strong', hours: null },
    { at: AT, kind: 'build', route: 'strong', hours: 0, size: null },
    { at: AT, kind: 'landing', hours: 0, batchSize: 1 },
  ]);
  assert.equal(fitted.from, '2026-10-18T00:00:00.000Z');
  assert.deepEqual(fitted.routes[0].durations.build.values, [2, 0]);
  assert.equal(fitted.routes[0].durations.build.mean, 1); // budget: derived empirical hours (2 + 0) / 2 = 1, not an elapsed clock observation.
  assert.equal(fitted.routes[0].observations.at(-1).size, 'unknown');
  assert.equal(fitted.landing.length, 1, 'missing failed count is not invented as zero');
  assert.equal(fitted.samples, 9);
  assert.deepEqual(JSON.parse(JSON.stringify(fitted)), fitted);
});

test('stats.model.capacity-work-is-agent-labor-while: capacity work is agent labor while dependency bounds include queue waits [R1,R2]', () => {
  const result = plan([item(1), item(2, { after: [1] })]);
  assert.equal(result.available, true);
  assert.equal(result.workHours, 6, 'two builds and two active reviews, without waiting labor');
  assert.equal(result.bounds.criticalPathHours, 14, 'the serial chain includes observed review waiting');
  assert.equal(result.bounds.landingHours, 0.5);
  assert.equal(result.tInfinityHours, 14);
  assert.equal(result.agents.recommended, 1, 'ceil(2*6/14), bounded by width and future unlock supply');
  assert.equal(result.monteCarlo.replicates, 100);
  assert.equal(result.monteCarlo.completed, 100);
  assert.deepEqual(result.agents, { recommended: 1, lower: 1, upper: 1 });
  assert.deepEqual(result.finishHours, { lower: 14.25, upper: 14.25 });
  assert.deepEqual(plan([item(1), item(2, { after: [1] })]), result, 'the same seed has no ambient randomness');
});

test('stats.model.capacity-distinguishes-observed-file-collision-waves: capacity distinguishes observed file collision waves and actual landing service [R1,R2]', () => {
  const parallel = plan([item(1), item(2)], fit(samples({ build: 2, review: 1, wait: 0, cycle: 3 })));
  const collision = plan([item(1), item(2, { files: ['src/1.js'] })], fit(samples({ build: 2, review: 1, wait: 0, cycle: 3 })));
  assert.equal(parallel.agents.recommended, 2);
  assert.equal(collision.agents.recommended, 1);
  assert.equal(collision.binding.kind, 'collisions');
  const landing = plan([item(1), item(2)], fit(samples({ wait: 0, landing: 20, cycle: 3 })));
  assert.equal(landing.bounds.landingHours, 40);
  assert.equal(landing.binding.kind, 'landing');
  const accepted = plan([item(1, { state: 'accepted', files: [] })]);
  assert.equal(accepted.workHours, 0, 'already accepted work has no new labor when observed landing failures are zero');
  assert.equal(accepted.bounds.landingHours, 0.25);
  assert.equal(accepted.finishHours.upper, 0.25);
});

test('stats.model.capacity-preserves-blocked-graphs-missing-fits: capacity preserves blocked graphs, missing fits and empty work as different states [R1,R2]', () => {
  for (const rows of [[item(1, { after: [900] })], [item(1, { after: [2] }), item(2, { after: [1] })]]) {
    const result = plan(rows);
    assert.equal(result.available, false);
    assert.equal(result.agents.recommended, null);
    assert.equal(result.finishHours.upper, null);
    assert.ok(result.unknown.length);
    assert.doesNotThrow(() => JSON.stringify(result));
  }
  for (const rows of [[item(1, { held: true }), item(2)], [item(1, { needsYou: true }), item(2)]]) {
    const result = plan(rows);
    assert.equal(result.available, true, 'a held or person-waiting item lowers supply instead of voiding the plan');
    assert.equal(result.agents.recommended, 1);
  }
  const fileless = plan([item(1, { files: [] }), item(2, { files: [] }), item(3)]);
  assert.equal(fileless.available, true, 'an item with no files joins no collision');
  assert.ok(!fileless.unknown.some(text => /collision/u.test(text)));
  assert.deepEqual(plan([item(1, { needsYou: true })]).needsYou, [1]);
  const unknown = plan([item(1)], fit([]));
  assert.equal(unknown.available, false);
  assert.equal(unknown.workHours, null);
  const empty = plan([], fit([]));
  assert.equal(empty.available, true);
  assert.equal(empty.workHours, 0);
  assert.deepEqual(empty.agents, { recommended: 0, lower: 0, upper: 0 });
  assert.deepEqual(empty.finishHours, { lower: 0, upper: 0 });
});

test('stats.model.capacity-includes-geometric-rework-labor-without: capacity includes geometric rework labor without treating idle rework gaps as labor [R1,R2]', () => {
  const result = plan([item(1)], fit(samples({ reject: true, cycle: 17 })));
  assert.equal(result.workHours, 6, 'q=.5 doubles observed three-hour active attempts');
  assert.equal(result.bounds.criticalPathHours, 17, 'two seven-hour attempts plus one three-hour idle rework gap');
  assert.equal(result.monteCarlo.completed, 100);
  assert.ok(result.monteCarlo.nonFinishing > 0, 'all-reject empirical bootstrap draws remain nonfinishing, not dropped');
  assert.equal(result.finishHours.upper, null, 'an unbounded empirical upper tail is explicit unknown in JSON');
  assert.match(capacityLines(result).join('\n'), /^Max useful agents now:/u);
  assert.match(capacityLines(result).join('\n'), /Binding:.*\nLever:/u);
  assert.match(capacityLines(result).join('\n'), /0 items lack recorded approval evidence/u);
});

test('stats.model.capacity-finish-quantiles-simulate-shared-service: capacity finish quantiles simulate shared service, independent review and a single lander [R1,R2]', () => {
  const fitted = fit(samples({ wait: 0, cycle: 3 }));
  const result = plan([item(1), item(2)], fitted, { liveSeats: 2 });
  assert.equal(result.agents.recommended, 2);
  assert.deepEqual(result.finishHours, { lower: 3.5, upper: 3.5 },
    'parallel two-hour builds, independent one-hour reviews and two sequential quarter-hour landing cycles');
  assert.ok(result.finishHours.lower > result.tInfinityHours,
    'a work/span lower bound is not reported as the simulated finish');
  const alone = plan([item(1), item(2)], fitted, { liveSeats: 1 });
  assert.equal(alone.binding.kind, 'seats');
  assert.equal(alone.finishHours.upper, null, 'one known identity cannot review its own work');
  assert.equal(alone.monteCarlo.nonFinishing, 100);
});


test('stats.model.capacity-straggler-p90-comes-from-observed: capacity straggler p90 comes from observed whole cycles and does not multiply recorded rework twice [R1,R2]', () => {
  const result = plan([item(1)], fit(samples({ reject: true, cycle: 40 })));
  assert.equal(result.workHours, 6, 'active work still uses the observed rejection probability');
  assert.equal(result.bounds.criticalPathHours, 17, 'component latency retains its distinct expected-attempt model');
  assert.equal(result.bounds.stragglerHours, 40, 'the observed whole-cycle p90 already includes rework');
  assert.equal(result.tInfinityHours, 40);
  const absent = plan([item(1)], fit(samples().filter(row => row.kind !== 'cycle')));
  assert.equal(absent.available, false, 'components cannot invent a missing whole-cycle measurement');
  assert.equal(absent.bounds.stragglerHours, null);
  const missing = fit(samples({ cycle: null }));
  assert.equal(missing.routes[0].durations.cycle.n, 0);
});

test('stats.model.one-hundred-seeded-capacity-replicates-finish: one hundred seeded capacity replicates finish under one second on a fifty-item board [R1,R2]', t => {
  const items = Array.from({ length: 50 }, (_, index) => item(index + 1, {
    after: index > 4 && index % 5 === 0 ? [index - 4] : [],
  }));
  const started = performance.now();
  const result = plan(items, fit(samples({ wait: 0, cycle: 3 })));
  const elapsed = performance.now() - started;
  t.diagnostic(`100 empirical replicates, 50 seeded items: ${elapsed.toFixed(2)} ms`);
  assert.equal(result.monteCarlo.completed, 100);
  assert.ok(result.finishHours.upper > 0);
  assert.ok(elapsed < 1_000, `100 replicates exceeded one second: ${elapsed} ms`); // budget: declared by frozen item #1212, 100 replicates under one second on the seeded board.
});

test('stats.model.submitted-items-preserve-their-shared-builder: submitted items preserve their shared builder identity in independent review capacity [R1,R2]', () => {
  const items = [item(1, { state: 'submitted', builderId: 'builder' }), item(2, { state: 'submitted', builderId: 'builder' })];
  const fitted = fit(samples({ wait: 0, cycle: 3 }));
  const result = plan(items, fitted, { liveSeats: { total: 2, ids: ['builder', 'reviewer'] } });
  assert.deepEqual(result.finishHours, { lower: 2.25, upper: 2.25 }, 'the only independent reviewer serializes both one-hour reviews');
  const unknown = plan(items, fitted, { liveSeats: 2 });
  assert.equal(unknown.finishHours.upper, null, 'a seat count cannot prove which seat is independent of an existing builder');
  assert.equal(unknown.monteCarlo.nonFinishing, 100);
});


test('stats.model.a-submitted-item-that-needs-only: a submitted item that needs only its review keeps its forecast without a build sample [R1,R2]', () => {
  const items = [item(1, { state: 'submitted', builderId: 'builder' })];
  const seats = { liveSeats: { total: 2, ids: ['builder', 'reviewer'] } };
  const measured = plan(items, fit(samples()), seats);
  const reviewOnly = plan(items, fit(samples().filter(row => row.kind !== 'build')), seats);
  assert.equal(measured.available, true, 'the matched control with a measured build is available');
  assert.equal(reviewOnly.available, true, 'q=0 review-only remaining work needs no build measurement');
  for (const field of ['workHours', 'tInfinityHours', 'bounds', 'agents', 'finishHours']) {
    assert.deepEqual(reviewOnly[field], measured[field], `${field} matches the measured-build control`);
  }
  assert.equal(reviewOnly.workHours, 1, 'only the one-hour review remains');
  const reworked = plan(items, fit(samples({ reject: true }).filter(row => row.kind !== 'build')), seats);
  assert.equal(reworked.tInfinityHours, null, 'with observed rejects a missing build sample still leaves the span unknown');
});

test('stats.model.accepted-work-includes-known-typed-landing: accepted work includes known typed landing-return repair labor and a failed landing still yields a number [R1,R2]', () => {
  const rows = samples({ reject: true, wait: 0 });
  rows.push({ at: AT, kind: 'landingOutcome', route: 'strong', sourceCommit: 'b'.repeat(40), acceptEvent: 2, failed: true, cause: 'conflict' },
    { at: AT, kind: 'build', route: 'strong', attempt: 'conflict', hours: 10 },
    { at: AT, kind: 'reworkGap', route: 'strong', attempt: 'conflict', hours: 3 },
    { at: AT, kind: 'build', route: 'strong', attempt: 'reject', hours: 2 });
  const result = plan([item(1, { state: 'accepted', files: [] })], fit(rows));
  assert.equal(result.workHours, 14, 'p=.5 repeats a ten-hour first repair plus two review hours and two reject-repair hours; the first repair build is not repeated on every review reject');
  assert.equal(result.available, true, 'failed landings use the observed lander cycles, never an unconditional unknown');
  assert.equal(result.agents.recommended, 0, 'accepted work needs no new agents');
  assert.ok(!result.unknown.some(text => /unmeasured/u.test(text)), result.unknown.join('; '));
  const noGap = plan([item(1, { state: 'accepted', files: [] })], fit(rows.filter(row => !(row.kind === 'reworkGap' && row.attempt === 'conflict'))));
  assert.equal(noGap.workHours, 14, 'known labor does not turn an unknown idle gap into zero latency');
  assert.ok(!/repair gap is missing/u.test(noGap.unknown.join('; ')), 'a cause gap falls back to the pooled route gap, so it cannot void the estimate');
  const noBuild = plan([item(1, { state: 'accepted', files: [] })], fit(rows.filter(row => !(row.kind === 'build' && row.attempt === 'conflict'))));
  assert.equal(noBuild.available, true, 'a cause with no repair-build sample repairs at the route build service instead of voiding the board');
  assert.ok(Number.isFinite(noBuild.workHours));
  const noAnyBuild = plan([item(1, { state: 'accepted', files: [] })], fit(rows.filter(row => row.kind !== 'build')));
  assert.equal(noAnyBuild.workHours, null);
  assert.match(noAnyBuild.unknown.join('; '), /repair build service is missing/);
});

test('stats.model.accepted-zero-labor-requires-genuinely-observed: accepted zero labor requires genuinely observed zero landing-return outcomes [R1,R2]', () => {
  const missing = plan([item(1, { state: 'accepted', files: [] })], fit(samples().filter(row => row.kind !== 'landingOutcome')));
  assert.equal(missing.workHours, null);
  assert.equal(missing.finishHours.upper, null);
  assert.match(missing.unknown.join('; '), /landing outcome coverage is missing/);
  const known = plan([item(1, { state: 'accepted', files: [] })]);
  assert.equal(known.workHours, 0);
  assert.equal(known.finishHours.upper, 0.25);
});


test('stats.model.malformed-landing-provenance-is-right-censored: malformed landing provenance is right-censored, never counted as an outcome [R1,R2]', () => {
  for (const invalid of [{ sourceCommit: 'not-a-commit' }, { acceptEvent: 0 }]) {
    const rows = [...samples(), { at: AT, kind: 'landingOutcome', route: 'strong',
      sourceCommit: 'b'.repeat(40), acceptEvent: 2, failed: false, cause: 'merged', ...invalid }];
    const fitted = fit(rows);
    assert.equal(fitted.routes[0].landingRisk.probability, 0, 'the rate counts only the classified outcomes');
    assert.equal(fitted.routes[0].landingRisk.unknown, 1);
    const result = plan([item(1, { state: 'accepted', files: [] })], fitted);
    assert.equal(result.available, true);
    assert.equal(result.workHours, 0);
    assert.ok(!result.unknown.some(text => /landing outcome coverage/u.test(text)), result.unknown.join('; '));
  }
});

test('stats.capacity-model.ready-width-without-history: with no usable fit the ready width is still returned and printed after the unknown agent line [R1,R2]', () => {
  const result = plan([item(1), item(2), item(3, { files: ['src/1.js'] }), item(4, { held: true }), item(5, { after: [1] })], fit([]));
  assert.equal(result.available, false);
  assert.equal(result.agents.recommended, null);
  assert.equal(result.readyWidth, 2, 'three ready items, two share a file; held and dependent items are not ready');
  const lines = capacityLines(result);
  assert.equal(lines[0].startsWith('Max useful agents now: unknown'), true);
  assert.equal(lines[1], '2 items can be built at once now.');
  assert.equal(plan([item(1, { files: ['a'] }), item(2, { files: ['b'] }), item(3, { files: ['c'] })], fit([])).readyWidth, 3);
});

test('stats.capacity-model.ready-width-with-history: with a usable fit the useful-agent line is unchanged and the ready width is still printed [R1,R2]', () => {
  const result = plan([item(1), item(2), item(3)]);
  assert.equal(result.available, true);
  assert.equal(result.readyWidth, 3);
  const lines = capacityLines(result);
  assert.match(lines[0], /^Max useful agents now: 3 \(/u);
  assert.ok(lines.includes('3 items can be built at once now.'));
});

test('stats.capacity-model.fallback-without-cost-sample: with no cost sample for the route the recommended agents fall back to min(width, supply) instead of null [R1,R2]', () => {
  const rows = samples().filter(row => row.kind !== 'build');
  const result = plan([item(1)], fit(rows));
  assert.equal(result.available, false, 'evaluate() has no estimate without a build sample');
  assert.equal(result.agents.recommended, 1);
  assert.equal(result.agents.basis, 'ready');
  const wide = plan([item(1, { files: ['a'] }), item(2, { files: ['b'] }), item(3, { files: ['c'], after: [1] })], fit(rows));
  assert.equal(wide.agents.recommended, 2, 'two ready items, the third waits on a dependency');
});

test('stats.capacity-model.fallback-line: the fallback prints "from ready work only" and the line is unchanged when evaluate() returns an estimate [R1,R2]', () => {
  const rows = samples().filter(row => row.kind !== 'build');
  const lines = capacityLines(plan([item(1), item(2)], fit(rows)));
  assert.equal(lines[0], 'Max useful agents now: 2 from ready work only.');
  assert.match(capacityLines(plan([item(1), item(2), item(3)]))[0], /^Max useful agents now: 3 \(/u);
});

test('stats.logic-capacity-model.recommended-from-eligible-ready: clause 1: agents.recommended is the eligible ready count plus one reviewer per 20 pending reviews [R1,R2]', () => {
  const items = [item(1), item(2)];
  assert.equal(plan(items, fit(), { eligibleReady: 5, pendingReviews: 0 }).agents.recommended, 5);
  assert.equal(plan(items, fit(), { eligibleReady: 5, pendingReviews: 1 }).agents.recommended, 6);
  assert.equal(plan(items, fit(), { eligibleReady: 5, pendingReviews: 20 }).agents.recommended, 6);
  assert.equal(plan(items, fit(), { eligibleReady: 5, pendingReviews: 21 }).agents.recommended, 7);
  assert.equal(plan(items, fit(), { eligibleReady: 0, pendingReviews: 40 }).agents.recommended, 2);
});

test('stats.logic-capacity-model.recommended-fallback-unchanged: clause 2: with no eligible ready count agents.recommended is what it is on main [R1,R2]', () => {
  const items = [item(1), item(2), item(3)];
  const base = plan(items).agents.recommended;
  assert.equal(base, 3);
  assert.equal(plan(items, fit(), { pendingReviews: 40 }).agents.recommended, base, 'pending reviews alone change nothing');
  assert.equal(plan(items, fit(), { eligibleReady: null }).agents.recommended, base);
  const rows = samples().filter(row => row.kind !== 'build');
  assert.equal(plan([item(1)], fit(rows)).agents.recommended, 1, 'ready-work fallback still applies');
});
