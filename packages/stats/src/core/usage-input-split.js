/** Numeric fields carried by the additive input-token split [N2,C7]. */
export const SPLIT_COUNTS = ['freshInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens'];

/** Identify additive numeric payloads so their move can retain the legacy replay floor. */
export function hasInputSplit(records) {
  return Array.isArray(records) && records.some(row => row && SPLIT_COUNTS.some(name => Object.hasOwn(row, name)));
}
