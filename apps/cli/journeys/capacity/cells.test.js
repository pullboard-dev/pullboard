import assert from 'node:assert/strict';
import { test } from 'node:test';
import { carryingCapacity } from '../../../../packages/stats/index.js';

/** Capacity names kernel churn, wide-item share and the busiest cell [R1,R2]. */
const BASE = Date.parse('2026-11-01T00:00:00Z');
const HOUR = 3_600_000;
const WINDOW = { from: new Date(BASE).toISOString(), to: new Date(BASE + 4 * HOUR).toISOString() };

/** Compare rational answers without hiding meaningful numerical drift. */
function near(actual, expected) { assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`); }

test('capacity pins kernel churn, wide-item share and the busiest cell [R1,R2]', () => {
  const touched = [['packages/kernel/k.js'], ['packages/kernel/k.js', 'packages/one/a.js'], ['packages/one/a.js', 'packages/two/b.js'], ['packages/one/a.js']];
  const landings = touched.map((files, index) => ({ at: BASE + (index + 0.5) * HOUR, files, lifetimeHours: 0.5, buildHours: 0.25, waitingHours: 0.25 }));
  const report = carryingCapacity({ ...WINDOW, landings });
  near(report.kernelChurnPerWeek, 2 * (168 / 4));
  near(report.wideItemShare, 0.5);
  assert.deepEqual(report.busiestCell, { cell: 'packages/one', changes: 3, share: 0.75 });
});

test('kernel churn, wide-item share and busiest cell stay unknown without complete landing files [R1,R2]', () => {
  const empty = carryingCapacity(WINDOW);
  assert.deepEqual([empty.kernelChurnPerWeek, empty.wideItemShare, empty.busiestCell], [null, null, null]);
  const missing = carryingCapacity({ ...WINDOW, landings: [{ at: BASE + HOUR, files: null }] });
  assert.deepEqual([missing.kernelChurnPerWeek, missing.wideItemShare, missing.busiestCell], [null, null, null]);
});
