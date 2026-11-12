/** A runner's rate card is stored in settings and validated [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTING_DESCRIPTIONS } from '../../../../packages/config/index.js';
import {
  parseRunnerRate,
  runnerRate,
  validateRunnerRates,
} from '../../../../packages/config/src/logic/runner-rates.js';

const CARD = { price: 1200, months: 36, watts: 85, kwhPrice: 0.14 };

test('a full rate card is accepted and read back, and a bad field is refused [C7]', () => {
  assert.deepEqual(parseRunnerRate(CARD), CARD);
  const rates = validateRunnerRates({ 'studio.local': { ...CARD, extra: 'dropped' } });
  assert.deepEqual(runnerRate(rates, 'studio.local'), CARD);
  for (const [field, bad] of [['price', -1], ['months', 0], ['months', 1.5], ['watts', -5], ['kwhPrice', '0.14'], ['price', NaN], ['watts', undefined]]) {
    const card = { ...CARD, [field]: bad };
    assert.throws(() => validateRunnerRates({ 'studio.local': card }), error => error.code === 'BAD_RUNNER_RATES' && error.message.includes(field), `${field}=${bad} is refused`);
  }
  assert.throws(() => parseRunnerRate({ price: 1 }), /BAD_RUNNER_RATES|months/u, 'a partial card is refused');
  assert.throws(() => validateRunnerRates([CARD]), error => error.code === 'BAD_RUNNER_RATES');
  assert.match(SETTING_DESCRIPTIONS.runnerRates.description, /rate|price/u, 'the inventory describes the card');
});

test('a runner with no card reads back as not set [C7]', () => {
  assert.equal(runnerRate(validateRunnerRates(undefined), 'studio.local'), null);
  assert.equal(runnerRate({ other: CARD }, 'studio.local'), null);
  assert.equal(runnerRate(undefined, 'studio.local'), null);
});
