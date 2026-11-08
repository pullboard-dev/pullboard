import { usageDollars } from '../../../config/src/core/cost-prices.js';
import { timeSplitRecords } from './cost-split.js';
/** One authenticated command bounds public usage revisions without discarding pending totals [N2,C7]. */
export const USAGE_BATCH_LIMIT = 1000;

/** Read-only usage totals for one item, kept free of board writers so show stays light [N2,C7]. */

/** Fixed public explanations for unavailable native token attribution, with no private paths or identities. */
export const UNKNOWN_USAGE_REASONS = ['native-session-unavailable', 'no-native-baseline', 'native-session-unreadable-or-reset', 'native-counter-unreadable-or-decreased', 'shared-session', 'missed-claim-anchor', 'not-recorded'];

/** Every numeric field a sanitized usage record carries. */
export const SPLIT_COUNTS = ['freshInputTokens', 'cacheReadInputTokens', 'cacheWriteInputTokens'];

/** Existing aggregate totals retain their historical shape when replaying old usage. */
export const COUNTS = ['inputTokens', 'outputTokens', 'wallMs', 'knownInputTokens', 'knownOutputTokens', ...SPLIT_COUNTS];

/** Sum known partial amounts while keeping incomplete totals visibly unknown. */
export function sumUsage(rows, prices) {
  const result = { inputTokens: 0, outputTokens: 0, knownInputTokens: 0, knownOutputTokens: 0, wallMs: 0, models: [], unknownReasons: [], shared: false };
  for (const name of SPLIT_COUNTS) result[name] = rows.length ? 0 : null;
  for (const row of rows) {
    result.shared ||= Boolean(row.shared);
    for (const reason of row.unknownReasons ?? []) if (!result.unknownReasons.includes(reason)) result.unknownReasons.push(reason);
    for (const name of COUNTS) {
      if (row[name] === null || row[name] === undefined || result[name] === null) result[name] = null;
      else {
        const total = result[name] + row[name];
        result[name] = Number.isSafeInteger(total) ? total : null;
      }
    }
    if (!result.models.includes(row.model)) result.models.push(row.model);
  }
  return { ...result, estimate: true, ...usageDollars(rows, prices) };
}

/** One item's totals; absence of any reported session is unknown rather than a false zero. */
export function itemCost(board, item, prices) {
  const records = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key GLOB ?").all(`cost:${item}:*`).flatMap((row) => { const value = JSON.parse(row.meta_value); return value.records.map((record) => ({ ...record, shared: Boolean(value.shared) })); });
  const total = records.length ? sumUsage(records, prices) : { ...unknownInputSplit(), inputTokens: null, outputTokens: null, knownInputTokens: 0, knownOutputTokens: 0, wallMs: 0, models: [], unknownReasons: ['not-recorded'], estimate: true, ...usageDollars([], prices) };
  if (!board.db.prepare('SELECT 1 FROM board_meta WHERE meta_key=?').get(`shared-item:${item}`)) return total;
  // A shared session's tokens divide by each item's claimed time; with no claimed time the split stays unknown, never guessed.
  const split = timeSplitRecords(board, item);
  if (split && records.every((record) => (record.unknownReasons ?? []).every((reason) => reason === 'shared-session'))) {
    const own = records.map((record) => ({ ...record, inputTokens: record.knownInputTokens, outputTokens: record.knownOutputTokens, unknownReasons: [], shared: false }));
    return { ...sumUsage([...own, ...split], prices), splitByTime: true, shared: false };
  }
  return { ...total, ...unknownInputSplit(), inputTokens: null, outputTokens: null, unknownReasons: [...new Set([...total.unknownReasons, 'shared-session'])], shared: true, ...usageDollars([{ shared: true }], prices) };
}

/** Public token/time summaries omit dollar accounting, which belongs to the separate pricing item. */
export function publicUsage(value) {
  if (Array.isArray(value)) return value.map(publicUsage);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['costUSD', 'knownCostUSD', 'estimate'].includes(key))
    .map(([key, child]) => [key, publicUsage(child)]));
}

/** Missing legacy and ambiguous item allocations never invent a cached or fresh zero. */
export function unknownInputSplit() {
  return Object.fromEntries(SPLIT_COUNTS.map(name => [name, null]));
}

/** Identify additive numeric payloads so their move can retain the legacy replay floor otherwise. */
export function hasInputSplit(records) {
  return Array.isArray(records) && records.some(row => row && SPLIT_COUNTS.some(name => Object.hasOwn(row, name)));
}
