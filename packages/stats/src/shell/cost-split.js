/** A shared native session's counters are split across its items by each item's claimed time, never by guesswork [N2]. */
import { COUNTS } from './cost-read.js';
import { sharedSessionTotals } from './cost-shared.js';

/** Milliseconds one seat held one item, from its claim to its submit or release, clamped to the session's last checkpoint. */
function claimedMs(board, seat, item, until) {
  let start = null;
  let total = 0;
  const events = board.db.prepare("SELECT event_at,event_kind FROM event WHERE event_by=? AND item_id=? AND event_kind IN ('claim','submit','release') ORDER BY event_id").all(seat, item);
  for (const event of events) {
    const at = Date.parse(event.event_at);
    if (event.event_kind === 'claim') start ??= at;
    else if (start !== null) { total += Math.max(0, Math.min(at, until) - start); start = null; }
  }
  if (start !== null) total += Math.max(0, until - start);
  return total;
}

/** Share a nonnegative integer by integer weights so the shares always add back to the whole. */
function apportion(value, weights) {
  const total = weights.reduce((sum, weight) => sum + BigInt(weight), 0n);
  let running = 0n;
  let cut = 0n;
  return weights.map((weight) => {
    running += BigInt(weight);
    const next = BigInt(value) * running / total;
    const share = next - cut;
    cut = next;
    return Number(share);
  });
}

/**
 * One item's numeric rows from every shared session it took part in, split by claimed time.
 * Returns null when any session cannot be split (no claimed time), so the item stays unknown rather than guessed.
 */
export function timeSplitRecords(board, item) {
  const groups = sharedSessionTotals(board).filter((group) => group.allocations.some((value) => value.item === item));
  if (!groups.length) return null;
  const rows = [];
  for (const group of groups) {
    const items = [...new Set(group.allocations.map((value) => value.item))].sort((a, b) => a - b);
    const weights = items.map((id) => group.allocations.filter((value) => value.item === id)
      .reduce((sum, value) => sum + claimedMs(board, value.seat, id, group.observedAt), 0));
    if (!weights.some((weight) => weight > 0)) return null;
    const at = items.indexOf(item);
    for (const record of group.records) {
      const row = { model: record.model, unknownReasons: [] };
      for (const name of COUNTS) {
        const whole = record[name];
        // The item's own record already carries its claimed time; only tokens are split.
        if (name === 'wallMs') row[name] = 0;
        else if (whole === null || whole === undefined) row[name] = null;
        else row[name] = apportion(whole, weights)[at];
      }
      if (record.inputTokens === null || record.outputTokens === null) row.unknownReasons.push(...(record.unknownReasons ?? []));
      rows.push(row);
    }
  }
  return rows;
}
