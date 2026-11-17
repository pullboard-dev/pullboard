/** Synthetic numeric usage proves local pricing arithmetic, not provider execution [N2]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicUsage } from '../../index.js';
import { sumUsage } from '../../index.js';
import { localUsage } from '../../../config/index.js';
import { usageDollars } from '../../../config/index.js';
import { validateCostPrices } from '../../../config/index.js';

const prices = {
  alpha: { freshInput: 2, cacheReadInput: 1, cacheWriteInput: 3, output: 4 },
  beta: { freshInput: 5, cacheReadInput: 5, cacheWriteInput: 5, output: 10 },
};

/** One sanitized numeric model row; the counts are hand-chosen fixture inputs. */
function usage(model, fresh = 100_000, read = 200_000, write = 50_000, output = 25_000) {
  return { model, inputTokens: fresh + read + write, knownInputTokens: fresh + read + write,
    outputTokens: output, knownOutputTokens: output, freshInputTokens: fresh,
    cacheReadInputTokens: read, cacheWriteInputTokens: write, wallMs: 7, unknownReasons: [] };
}

test('stats.cost.legacy-missing-rate-shared-and-zero: legacy, missing-rate, shared and zero pricing preserve unknown versus measured zero [N2]', () => {
  const row = usage('alpha');
  assert.equal(usageDollars([row], prices).costUSD, .65);
  assert.equal(usageDollars([{ ...row, cacheWriteInputTokens: null }], prices).costUSD, null);
  assert.equal(usageDollars([{ ...row, shared: true }], prices).costUSD, null);
  assert.equal(usageDollars([{ ...row, model: 'absent' }], prices).costUSD, null);
  assert.equal(usageDollars([usage('alpha', 0, 0, 0, 0)], prices).costUSD, 0);
  assert.equal(usageDollars([row], { alpha: { freshInput: 0, cacheReadInput: 0, cacheWriteInput: 0, output: 0 } }).costUSD, 0);
  const legacy = { model: 'beta', inputTokens: 350_000, outputTokens: 25_000 };
  assert.equal(usageDollars([legacy], prices).costUSD, 2, 'equal input rates price the legacy aggregate without inventing a split');
  assert.equal(usageDollars([{ ...legacy, model: 'alpha' }], prices).costUSD, null);
  assert.deepEqual(localUsage(sumUsage([row]), publicUsage), publicUsage(sumUsage([row])));
  assert.equal(Object.hasOwn(localUsage({ records: [{ costUSD: 999, knownCostUSD: 999 }] }, publicUsage).records[0], 'costUSD'), false,
    'historical dollar payloads are never restored as locally computed prices');
  assert.equal(localUsage({ rows: [sumUsage([row], prices)] }, publicUsage).rows[0].costUSD, .65);
  for (const invalid of [null, [], { alpha: { output: -1 } }, { alpha: { output: Infinity } }, { alpha: { secret: 1 } }]) {
    assert.throws(() => validateCostPrices(invalid), error => error.code === 'BAD_MACHINE_SETTINGS');
  }
  validateCostPrices(prices);
});
