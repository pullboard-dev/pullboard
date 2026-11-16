/** costPerMinute prices a runner minute from its rate card [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costPerMinute } from '../../src/logic/runner-rates.js';

const SAMPLE = { price: 360, months: 30, watts: 60, kwhPrice: 0.08 };

test('clause 1: costPerMinute is price over payoff minutes plus watts times the kWh price per minute, about 0.00036 for the sample card [C7]', () => {
  const payoffMinutes = SAMPLE.months * 30 * 24 * 60;
  const expected = SAMPLE.price / payoffMinutes + (SAMPLE.watts / 1000) * SAMPLE.kwhPrice / 60;
  assert.equal(costPerMinute(SAMPLE), expected);
  assert.ok(Math.abs(costPerMinute(SAMPLE) - 0.00036) < 0.00001, String(costPerMinute(SAMPLE)));
  assert.equal(costPerMinute({ price: 0, months: 1, watts: 0, kwhPrice: 0 }), 0);
  assert.throws(() => costPerMinute({ price: 1, months: 0, watts: 0, kwhPrice: 0 }, 'box'), error => error.code === 'BAD_RUNNER_RATES');
});
