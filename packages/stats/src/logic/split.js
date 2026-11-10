/** Classify additive usage fields without loading prices or totals [N2,H16]. */
export const SPLIT_COUNTS = ['freshInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens'];

/** Preserve legacy usage floors unless an additive split field is present. */
export function hasInputSplit(records) {
  return Array.isArray(records) && records.some(row => row && SPLIT_COUNTS.some(name => Object.hasOwn(row, name)));
}
