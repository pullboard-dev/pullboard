/** Read-only usage totals for one item, kept free of board writers so show stays light [N2,C7]. */

/** Every numeric field a sanitized usage record carries. */
export const COUNTS = ['inputTokens', 'outputTokens', 'costUSD', 'wallMs', 'knownInputTokens', 'knownOutputTokens', 'knownCostUSD'];

/** Sum known partial amounts while keeping incomplete totals visibly unknown. */
export function sumUsage(rows) {
  const result = { inputTokens: 0, outputTokens: 0, costUSD: 0, knownInputTokens: 0, knownOutputTokens: 0, knownCostUSD: 0, wallMs: 0, models: [], shared: false };
  for (const row of rows) {
    result.shared ||= Boolean(row.shared);
    for (const name of COUNTS) {
      if (row[name] === null || result[name] === null) result[name] = null;
      else {
        const total = result[name] + row[name];
        result[name] = Number.isFinite(total) && (name.includes('Cost') || name === 'costUSD' || Number.isSafeInteger(total)) ? total : null;
      }
    }
    if (!result.models.includes(row.model)) result.models.push(row.model);
  }
  return { ...result, estimate: true };
}

/** One item's totals; absence of any reported session is unknown rather than a false zero. */
export function itemCost(board, item) {
  const records = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key GLOB ?").all(`cost:${item}:*`).flatMap((row) => { const value = JSON.parse(row.meta_value); return value.records.map((record) => ({ ...record, shared: Boolean(value.shared) })); });
  const total = records.length ? sumUsage(records) : { inputTokens: null, outputTokens: null, costUSD: null, knownInputTokens: 0, knownOutputTokens: 0, knownCostUSD: 0, wallMs: 0, models: [], estimate: true };
  return board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`shared-item:${item}`) ? { ...total, inputTokens: null, outputTokens: null, costUSD: null, shared: true } : total;
}
