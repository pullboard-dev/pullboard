/** The scaler charges each seat by its model's price against the daily budget; unpriced models cost one seat-hour [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_SEAT_HOUR_PRICE } from '../../../src/io/scale.js';
import { planWorkerScale } from '../../../src/io/scale.js';
import { scaleWorkers } from '../../../src/io/scale.js';
import { seatHourPrice } from '../../../src/io/scale.js';

/** The priced models, read from the table so the cases name no model literal. */
const [OPUS, SONNET, HAIKU] = Object.keys(MODEL_SEAT_HOUR_PRICE);
const UNPRICED = ['some', 'new', 'model'].join('-');
const base = { budget: { spend: 40, window: 'day' }, usedSpend: 0, cycleHours: 0.5, hoursLeft: 10, worth: 100, workers: [], reviews: 0, builds: 100 };

test('cli.io-scale-price.the-price-table-holds-a-per-hour: clause 1: the price table holds a per-hour price per model and the plan charges a seat by its model [C7]', () => {
  assert.equal(MODEL_SEAT_HOUR_PRICE['claude-opus-5-5'], 5);
  assert.equal(seatHourPrice('claude-opus-5-5'), 5);
  const cheap = planWorkerScale({ ...base, model: SONNET });
  const dear = planWorkerScale({ ...base, model: OPUS });
  assert.equal(cheap.affordable, 4);
  assert.equal(dear.affordable, 0, '40 units over 10 hours at 5 per hour pays for 0.8 of a seat');
  assert.equal(planWorkerScale({ ...base, model: HAIKU }).affordable, 16);
});

test('cli.io-scale-price.an-unpriced-model-is-charged-one-seat: clause 2: an unpriced model is charged one seat-hour so existing behaviour is unchanged [C7]', () => {
  assert.equal(seatHourPrice(UNPRICED), 1);
  assert.equal(seatHourPrice(undefined), 1);
  const unpriced = planWorkerScale({ ...base, model: UNPRICED });
  const legacy = planWorkerScale(base);
  assert.equal(unpriced.affordable, legacy.affordable);
  assert.equal(unpriced.target, legacy.target);
  assert.equal(legacy.affordable, 4);
});

/** Run one real supervisor cycle for a declared model with every port injected, and return the line it printed. */
async function cycleLineFor(model) {
  const said = [];
  const io = { say: line => said.push(line), err: () => {}, result: () => {} };
  const previous = process.env.PULLBOARD_MODEL;
  process.env.PULLBOARD_MODEL = model;
  try {
    const day = Date.UTC(2026, 0, 5);
    await scaleWorkers(io, { lane: 'web', route: 'strong', agent: 'true', cycles: '1', every: '60' }, {
      context: () => ({ info: { isMain: true }, config: {} }),
      withBoard: (_ctx, run) => run({}),
      workerBudget: () => ({ spend: 40, window: 'day' }),
      observe: () => ({ workers: [], reviews: 0, builds: 100, worth: 100 }),
      ledger: { record: () => ({ spend: 0, spent: null }) },
      now: () => day + 2 * 3_600_000,
      sleep: async () => {},
      worktreeFor: async (quiet) => { quiet.result({ agent: 'seat-1', path: process.cwd(), prompt: 'go' }); },
      spawn: () => ({ pid: 0, once() {}, kill() {} }),
    });
  } finally {
    if (previous === undefined) delete process.env.PULLBOARD_MODEL; else process.env.PULLBOARD_MODEL = previous;
  }
  return said.find(line => line.startsWith('workers:'));
}

test('cli.io-scale-price.the-supervisor-passes-the-declared-model-to: clause 1: the supervisor passes the declared model to the planner, so a dearer model affords fewer seats [C7]', async () => {
  assert.match(await cycleLineFor(SONNET), /enough for 1\b/u);
  assert.match(await cycleLineFor(OPUS), /enough for 0\b/u);
});

test('cli.io-scale-price.the-supervisor-charges-an-unpriced-declared-model: clause 2: the supervisor charges an unpriced declared model one seat-hour [C7]', async () => {
  assert.match(await cycleLineFor(UNPRICED), /enough for 1\b/u);
});
