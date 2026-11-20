/** The cycle clock decides when the line may be retuned from landings, elapsed time and the oldest wait [C7,#1099]. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { tuneCycleDue } from "../../../../src/logic/flow/tune/cycle.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const calm = { minutes: 10, targetMinutes: 30 };

test("stats.tune-cycle.closed-after-eight-and-an-hour: clause 1: [C7] eight landings and an hour since the last change make the cycle due", () => {
  const state = { landedSinceChange: 8, lastChangeAt: NOW - HOUR, oldestWait: calm };
  assert.deepEqual(tuneCycleDue(state, NOW), { due: true, reason: "cycle" });
  assert.deepEqual(tuneCycleDue({ ...state, landedSinceChange: 12, lastChangeAt: NOW - 3 * HOUR }, NOW), { due: true, reason: "cycle" });
});

test("stats.tune-cycle.open-before-an-hour: clause 1: [C7] eight landings before the hour has passed stay open on the floor", () => {
  const state = { landedSinceChange: 8, lastChangeAt: NOW - HOUR + 1, oldestWait: calm };
  assert.deepEqual(tuneCycleDue(state, NOW), { due: false, reason: "floor" });
  assert.equal(tuneCycleDue({ ...state, landedSinceChange: 7, lastChangeAt: NOW - 2 * HOUR }, NOW).due, false);
});

test("stats.tune-cycle.closed-at-seven-days: clause 1: [C7] seven days force the cycle closed with fewer than eight landings", () => {
  const state = { landedSinceChange: 2, lastChangeAt: NOW - 7 * 24 * HOUR, oldestWait: calm };
  assert.deepEqual(tuneCycleDue(state, NOW), { due: true, reason: "ceiling" });
  assert.equal(tuneCycleDue({ ...state, lastChangeAt: NOW - 7 * 24 * HOUR + 1 }, NOW).due, false);
});

test("stats.tune-cycle.act-now-on-breach: clause 1: [C7] a wait whose oldest item is over three times its target is due at once", () => {
  const state = { landedSinceChange: 0, lastChangeAt: NOW - 1000, oldestWait: { minutes: 91, targetMinutes: 30 } };
  assert.deepEqual(tuneCycleDue(state, NOW), { due: true, reason: "breach" });
  assert.equal(tuneCycleDue({ ...state, oldestWait: { minutes: 90, targetMinutes: 30 } }, NOW).due, false);
});
