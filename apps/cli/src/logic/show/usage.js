/** The usage line `pullboard show` prints, kept pure so show formats nothing itself [C7]. */

/**
 * The one usage line show prints: the full form with --detail, the short form otherwise.
 *
 * @param {any} cost the item's cost row (token counts, models, unknownReasons, shared, splitByTime)
 * @param {{ detail?: boolean, dollars?: string }} facts whether --detail was given, and the dollar text the caller formatted
 * @returns {string | null} the line, or null when the short form has no tokens to show
 */
export function usageLine(cost, { detail = false, dollars = '' } = {}) {
  const split = cost.shared ? '; shared-session item split unknown' : cost.splitByTime ? '; split by time with a shared session' : '';
  if (detail) return `usage: input ${cost.inputTokens ?? 'unknown'} (fresh ${cost.freshInputTokens ?? 'unknown'}, cached read ${cost.cacheReadInputTokens ?? 'unknown'}, cached write ${cost.cacheWriteInputTokens ?? 'unknown'}), output ${cost.outputTokens ?? 'unknown'}, ${cost.wallMs} ms${split}; models ${cost.models.join(', ') || 'unknown'}${cost.unknownReasons.length ? '; unknown: ' + cost.unknownReasons.join(', ') : ''}${dollars}`;
  if (cost.inputTokens != null || cost.outputTokens != null) return `usage: input ${cost.inputTokens ?? 'unknown'}, output ${cost.outputTokens ?? 'unknown'}${split}${dollars}; --detail`;
  return null;
}
