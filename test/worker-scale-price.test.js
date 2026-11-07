/** The scaler charges each seat by its model's price against the daily budget; unpriced models cost one seat-hour [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_SEAT_HOUR_PRICE, planWorkerScale, seatHourPrice } from '../apps/cli/src/shell/worker-scale.js';

const base = { budget: { seatHours: 40, window: 'day' }, usedHours: 0, cycleHours: 0.5, hoursLeft: 10, worth: 100, workers: [], reviews: 0, builds: 100 };

test('clause 1: the price table holds a per-hour price per model and the plan charges a seat by its model [C7]', () => {
  assert.equal(MODEL_SEAT_HOUR_PRICE['claude-opus-5-5'], 5);
  assert.equal(seatHourPrice('claude-opus-5-5'), 5);
  const cheap = planWorkerScale({ ...base, model: 'claude-sonnet-5-5' });
  const dear = planWorkerScale({ ...base, model: 'claude-opus-5-5' });
  assert.equal(cheap.affordable, 4);
  assert.equal(dear.affordable, 0, '40 units over 10 hours at 5 per hour pays for 0.8 of a seat');
  assert.equal(planWorkerScale({ ...base, model: 'claude-haiku-5-5' }).affordable, 16);
});

test('clause 2: an unpriced model is charged one seat-hour so existing behaviour is unchanged [C7]', () => {
  assert.equal(seatHourPrice('some-new-model'), 1);
  assert.equal(seatHourPrice(undefined), 1);
  const unpriced = planWorkerScale({ ...base, model: 'some-new-model' });
  const legacy = planWorkerScale(base);
  assert.equal(unpriced.affordable, legacy.affordable);
  assert.equal(unpriced.target, legacy.target);
  assert.equal(legacy.affordable, 4);
});
