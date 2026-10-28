/** Read-only usage totals for one item, kept free of board writers so show stays light [N2,C7]. */

/** Fixed public explanations for unavailable native token attribution, with no private paths or identities. */
export const UNKNOWN_USAGE_REASONS = ['native-session-unavailable', 'no-native-baseline', 'native-session-unreadable-or-reset', 'native-counter-unreadable-or-decreased', 'shared-session', 'missed-claim-anchor', 'not-recorded'];

/** Every numeric field a sanitized usage record carries. */
export const COUNTS = ['inputTokens', 'outputTokens', 'wallMs', 'knownInputTokens', 'knownOutputTokens'];

/** Sum known partial amounts while keeping incomplete totals visibly unknown. */
export function sumUsage(rows) {
  const result = { inputTokens: 0, outputTokens: 0, knownInputTokens: 0, knownOutputTokens: 0, wallMs: 0, models: [], unknownReasons: [], shared: false };
  for (const row of rows) {
    result.shared ||= Boolean(row.shared);
    for (const reason of row.unknownReasons ?? []) if (!result.unknownReasons.includes(reason)) result.unknownReasons.push(reason);
    for (const name of COUNTS) {
      if (row[name] === null || result[name] === null) result[name] = null;
      else {
        const total = result[name] + row[name];
        result[name] = Number.isSafeInteger(total) ? total : null;
      }
    }
    if (!result.models.includes(row.model)) result.models.push(row.model);
  }
  return { ...result, estimate: true };
}

/** One item's totals; absence of any reported session is unknown rather than a false zero. */
export function itemCost(board, item) {
  const records = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key GLOB ?").all(`cost:${item}:*`).flatMap((row) => { const value = JSON.parse(row.meta_value); return value.records.map((record) => ({ ...record, shared: Boolean(value.shared) })); });
  const total = records.length ? sumUsage(records) : { inputTokens: null, outputTokens: null, knownInputTokens: 0, knownOutputTokens: 0, wallMs: 0, models: [], unknownReasons: ['not-recorded'], estimate: true };
  return board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`shared-item:${item}`) ? { ...total, inputTokens: null, outputTokens: null, unknownReasons: [...new Set([...total.unknownReasons, 'shared-session'])], shared: true } : total;
}

/** Public token/time summaries omit dollar accounting, which belongs to the separate pricing item. */
export function publicUsage(value) {
  if (Array.isArray(value)) return value.map(publicUsage);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['costUSD', 'knownCostUSD', 'estimate'].includes(key))
    .map(([key, child]) => [key, publicUsage(child)]));
}
