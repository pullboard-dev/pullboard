/** Max useful builder seats come from marginal landings per added seat and churn over a trailing window [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maxUsefulBuilders } from '../../../index.js';
import { staffingLines } from '../../../src/logic/capacity/useful.js';
import { staffingSeats } from '../../../src/logic/capacity/useful.js';
import * as light from '../../../light.js';

const NOW = Date.parse('2026-11-15T00:00:00.000Z');
const HOUR = 3_600_000;

/** Seeded history: `hours` observed hours at each seat count with the given landings and churn per hour. */
function history(plan, { age = 1 } = {}) {
  const rows = [];
  for (const [seats, landings, churn, hours] of plan) {
    for (let i = 0; i < hours; i += 1) rows.push({ at: NOW - (age + rows.length) * HOUR, seats, landings, churn });
  }
  return rows;
}

test('stats.useful.c7-max-useful-builder-seats-are: clause 1: [C7] max useful builder seats are computed from marginal landings per added seat and churn over a trailing window on a seeded history', () => {
  // 1 to 4 seats add 3, 3 and 2 net landings; the 5th adds a landing but churn eats it, so 4 is the last useful seat.
  const rows = history([[1, 3, 0, 10], [2, 6, 0, 10], [3, 9, 0, 10], [4, 12, 2, 10], [5, 14, 6, 10]]);
  const out = maxUsefulBuilders(rows, { now: NOW });
  assert.equal(out.max, 4);
  assert.deepEqual(out.curve.map(point => point.marginal), [null, 3, 3, 1, -2]);
  assert.deepEqual(out.inputs.counts, [1, 2, 3, 4, 5]);
  assert.equal(out.window.to - out.window.from, 7 * 24 * HOUR);

  // Rows older than the trailing window are ignored, so a stale 6-seat burst never raises the answer.
  const stale = [...rows, ...history([[6, 40, 0, 10]], { age: 24 * 9 })];
  assert.equal(maxUsefulBuilders(stale, { now: NOW }).max, 4);

  // Heavy churn at the top count lowers the answer; the same landings with no churn keep it.
  const calm = maxUsefulBuilders(history([[1, 3, 0, 5], [2, 5, 0, 5]]), { now: NOW });
  const churny = maxUsefulBuilders(history([[1, 3, 0, 5], [2, 5, 3, 5]]), { now: NOW });
  assert.equal(calm.max, 2);
  assert.equal(churny.max, 1);

  // One observed seat count is unknown, never zero or a guess.
  assert.equal(maxUsefulBuilders(history([[3, 9, 0, 5]]), { now: NOW }).max, null);
});

test('stats.logic-capacity-staffing.counts: clause 1: staffingSeats caps builders at the max useful when known and gives one reviewer per 8 builders, at least 1 when any builder runs [C7,#11832]', () => {
  assert.deepEqual(staffingSeats({ ready: 8 }), { builders: 8, reviewers: 1, ratio: 8 });
  assert.equal(staffingSeats({ ready: 9 }).reviewers, 2);
  assert.deepEqual(staffingSeats({ ready: 0 }), { builders: 0, reviewers: 0, ratio: 8 });
  assert.equal(staffingSeats({ ready: 1 }).reviewers, 1);
  assert.equal(staffingSeats({ ready: 20, maxUseful: 5 }).builders, 5);
  assert.equal(staffingSeats({ ready: 3, maxUseful: 5 }).builders, 3);
  assert.equal(staffingSeats({ ready: 20, maxUseful: null }).builders, 20);
  assert.equal(staffingSeats({ ready: 16, ratio: 4 }).reviewers, 4);
});

test('stats.logic-capacity-staffing.line: clause 1: staffingLines prints one line naming the builder seats, the review seats and the ratio [C7,#11832]', () => {
  assert.equal(staffingLines(staffingSeats({ ready: 8 })), 'Staffing: 8 builders, 1 reviewer (8:1)');
  assert.equal(staffingLines(staffingSeats({ ready: 9 })), 'Staffing: 9 builders, 2 reviewers (8:1)');
});

test('stats.logic-capacity-staffing.exported: clause 2: staffingSeats and staffingLines are exported statically through the light door and answer as the useful module does [C7,#12397]', () => {
  assert.equal(light.staffingSeats, staffingSeats);
  assert.equal(light.staffingLines, staffingLines);
  assert.equal(light.usefulBuilderLines.name, 'usefulBuilderLines');
  assert.deepEqual(light.staffingSeats({ ready: 9 }), staffingSeats({ ready: 9 }));
});
