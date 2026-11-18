/** checkVerdict compares a check's measured time to its ceiling at claim time [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkVerdict } from '../../src/logic/check-verdict.js';

test('config.logic-check-verdict.clause-1-ok-at-or-under-the-ceiling: clause 1: checkVerdict returns ok when measuredMs is at or under ceilingMs [C7]', () => {
  assert.deepEqual(checkVerdict({ measuredMs: 900, ceilingMs: 1000 }), { ok: true });
  assert.deepEqual(checkVerdict({ measuredMs: 1000, ceilingMs: 1000 }), { ok: true });
  assert.deepEqual(checkVerdict({ measuredMs: 0, ceilingMs: 1000, strict: true }), { ok: true });
});

test('config.logic-check-verdict.clause-2-refuses-over-and-unsound: clause 2: checkVerdict refuses CHECK_OVER_CEILING when measuredMs is over ceilingMs, and CHECK_UNSOUND when strict and measuredMs is missing [C7]', () => {
  assert.throws(() => checkVerdict({ measuredMs: 1001, ceilingMs: 1000 }), error => error.code === 'CHECK_OVER_CEILING');
  assert.throws(() => checkVerdict({ measuredMs: 1001, ceilingMs: 1000, strict: true }), error => error.code === 'CHECK_OVER_CEILING');
  assert.throws(() => checkVerdict({ ceilingMs: 1000, strict: true }), error => error.code === 'CHECK_UNSOUND');
  assert.throws(() => checkVerdict({ measuredMs: null, ceilingMs: 1000, strict: true }), error => error.code === 'CHECK_UNSOUND');
  assert.throws(() => checkVerdict({ measuredMs: Number.NaN, ceilingMs: 1000, strict: true }), error => error.code === 'CHECK_UNSOUND');
  assert.deepEqual(checkVerdict({ ceilingMs: 1000 }), { ok: true }, 'a non-strict check with no measurement is not refused');
});

test('config.logic-check-verdict.clause-3-pending-remeasure-is-ok: clause 3: checkVerdict returns ok for a non-strict check whose remeasurePending is true, so an old check is never refused while its remeasure is pending [C7]', () => {
  assert.deepEqual(checkVerdict({ measuredMs: 5000, ceilingMs: 1000, remeasurePending: true }), { ok: true });
  assert.deepEqual(checkVerdict({ ceilingMs: 1000, remeasurePending: true, strict: false }), { ok: true });
  assert.throws(() => checkVerdict({ ceilingMs: 1000, remeasurePending: true, strict: true }), error => error.code === 'CHECK_UNSOUND', 'a strict check is not excused by a pending remeasure');
});
