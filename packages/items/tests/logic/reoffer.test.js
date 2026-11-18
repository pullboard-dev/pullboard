/** A returned rejection unclaimed for 20 minutes is due for re-offer [C7,#11093]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reofferDue } from '../../src/logic/reoffer.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const MINUTE = 60_000;

test('items.reoffer.twenty-minutes: clause 1: reofferDue(returnedAt, now) is false before 20 minutes and true from 20 minutes on, and false when returnedAt is missing [C7,#11093]', () => {
  assert.equal(reofferDue(new Date(NOW - 19 * MINUTE - 59_000).toISOString(), NOW), false);
  assert.equal(reofferDue(new Date(NOW - 20 * MINUTE).toISOString(), NOW), true);
  assert.equal(reofferDue(NOW - 45 * MINUTE, NOW), true);
  assert.equal(reofferDue(null, NOW), false);
  assert.equal(reofferDue(undefined, NOW), false);
});
