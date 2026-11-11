/** One Opus seat of daily spend buys proportionally more Haiku seats, and the scaler never launches past the spend [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_SEAT_HOUR_PRICE } from '../../../src/io/scale.js';
import { planWorkerScale } from '../../../src/io/scale.js';

/** The priced models, read from the table so the cases name no model literal. */
const [OPUS, , HAIKU] = Object.keys(MODEL_SEAT_HOUR_PRICE);
const HOURS_LEFT = 10;
/** A daily spend that pays one Opus seat through the rest of the window, with plenty of work and worth. */
const OPUS_SPEND = MODEL_SEAT_HOUR_PRICE[OPUS] * HOURS_LEFT;
const base = { budget: { spend: OPUS_SPEND, window: 'day' }, usedSpend: 0, cycleHours: 0.5, hoursLeft: HOURS_LEFT, worth: 1000, workers: [], reviews: 0, builds: 1000 };

test('clause 1: a daily spend that allows 1 Opus seat allows proportionally more Haiku seats by price [C7]', () => {
  assert.equal(planWorkerScale({ ...base, model: OPUS }).affordable, 1);
  const haiku = planWorkerScale({ ...base, model: HAIKU });
  assert.equal(haiku.affordable, MODEL_SEAT_HOUR_PRICE[OPUS] / MODEL_SEAT_HOUR_PRICE[HAIKU]);
  assert.ok(haiku.affordable > 1);
  const double = planWorkerScale({ ...base, budget: { spend: OPUS_SPEND * 2, window: 'day' }, model: HAIKU });
  assert.equal(double.affordable, haiku.affordable * 2, 'doubling the spend doubles the Haiku seats');
});

test('clause 2: the scaler never launches more seats than the spend allows [C7]', () => {
  for (const model of [OPUS, HAIKU]) {
    const plan = planWorkerScale({ ...base, model });
    assert.equal(plan.launch, plan.affordable, `${model}: with unlimited work it launches exactly what the spend allows`);
    assert.ok(plan.target <= plan.affordable);
    const used = planWorkerScale({ ...base, model, usedSpend: OPUS_SPEND });
    assert.equal(used.launch, 0, `${model}: spend used up launches nothing`);
    const running = Array.from({ length: plan.affordable }, (_, i) => ({ id: `seat-${i}`, busy: true }));
    assert.equal(planWorkerScale({ ...base, model, workers: running }).launch, 0, `${model}: seats already running count against the spend`);
  }
});
