/** Local USD projections; rates and derived dollars never become recorded usage [N2]. */
import { Refused } from '../../../kernel/light.js';

const INPUTS = [['freshInputTokens', 'freshInput'], ['cacheReadInputTokens', 'cacheReadInput'], ['cacheWriteInputTokens', 'cacheWriteInput']];
const RATES = [...INPUTS.map(([, rate]) => rate), 'output'];
const LOCAL_DOLLARS = Symbol('local dollar projection');

/** Validate optional settings.costPrices: model names map to USD per million tokens, with missing rates unknown. */
export function validateCostPrices(prices) {
  if (prices === undefined) return;
  if (!prices || typeof prices !== 'object' || Array.isArray(prices)
    || Object.entries(prices).some(([model, rates]) => !model || model.length > 160 || /[\u0000-\u001f\u007f]/u.test(model)
      || !rates || typeof rates !== 'object' || Array.isArray(rates)
      || Object.entries(rates).some(([name, value]) => !RATES.includes(name) || typeof value !== 'number' || !Number.isFinite(value) || value < 0))) {
    throw new Refused('BAD_MACHINE_SETTINGS', 'costPrices maps models to nonnegative USD-per-million freshInput, cacheReadInput, cacheWriteInput and output rates; omit unavailable rates');
  }
}

/** Price original model rows before grouping; incomplete or shared allocations keep the total unknown. */
export function usageDollars(rows, prices) {
  if (prices === undefined) return {};
  let knownCostUSD = 0;
  let complete = rows.length > 0;
  for (const row of rows) {
    if (row.shared) { complete = false; continue; }
    const priced = Object.hasOwn(prices, row.model);
    const rates = priced ? prices[row.model] : {};
    if (!priced) complete = false;
    const parts = [...INPUTS.map(([count, rate]) => [row[count], rates[rate]]), [row.outputTokens, rates.output]];
    // Legacy inclusive input can be priced only when every input category has the same known rate.
    if (INPUTS.some(([count]) => row[count] === undefined || row[count] === null)
      && INPUTS.every(([, rate]) => rates[rate] !== undefined && rates[rate] === rates.freshInput)) {
      parts.splice(0, INPUTS.length, [row.inputTokens, rates.freshInput]);
    }
    for (const [count, rate] of parts) {
      if (count === 0) continue;
      if (!Number.isSafeInteger(count) || count < 0 || rate === undefined) { complete = false; continue; }
      const dollars = count * rate / 1_000_000;
      if (!Number.isFinite(dollars) || !Number.isFinite(knownCostUSD + dollars)) { complete = false; continue; }
      knownCostUSD += dollars;
    }
  }
  return { costUSD: complete ? knownCostUSD : null, knownCostUSD, [LOCAL_DOLLARS]: true };
}

/** Restore only locally computed dollars after the existing publication sanitizer has removed dollar payloads. */
export function localUsage(value, sanitize) {
  if (Array.isArray(value)) return value.map(child => localUsage(child, sanitize));
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(sanitize(value)).map(([name, child]) => [name, localUsage(value[name], sanitize)]));
  if (value[LOCAL_DOLLARS]) for (const name of ['costUSD', 'knownCostUSD']) result[name] = value[name];
  return result;
}

/** Append optional local dollar estimates without changing text on machines without a price table. */
export function dollarText(value) {
  return Object.hasOwn(value, 'costUSD') ? `; cost USD ${value.costUSD === null ? 'unknown' : value.costUSD.toFixed(6)}` : '';
}
