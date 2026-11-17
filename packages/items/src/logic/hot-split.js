/** Hot/cold split of board items for the state build (#9338): open and recent items stay whole [C7]. */

/** Finished items are the withdrawn ones: landed or withdrawn, nothing left to do. */
const FINISHED = 'withdrawn';

/**
 * Keep open items and recently finished items whole; count older finished items by status.
 * Pure: `now` (ms since epoch) is a parameter so the caller owns the clock.
 * @param {Array<{status: string, updatedAt?: string}>} items
 * @param {number} now
 * @param {number} recentMs a finished item updated within this many ms stays whole
 * @returns {{kept: object[], counts: Record<string, number>}}
 */
export function splitRecent(items, now, recentMs) {
  const kept = [];
  const counts = {};
  for (const item of items ?? []) {
    const updated = Date.parse(item.updatedAt ?? '');
    const old = item.status === FINISHED && Number.isFinite(updated) && now - updated > recentMs;
    if (!old) kept.push(item);
    else counts[item.status] = (counts[item.status] ?? 0) + 1;
  }
  return { kept, counts };
}
