/** The clean window of one move table's shadow compares: when it began and whether it has run long enough [C7]. */

/** The hours a clean window must run before a table may go live (#8395 asks for 24). */
export const WINDOW_HOURS = 24;

/**
 * Report a table's zero-disagreement window. It starts at the later of the first compare and the last disagreement,
 * so a fix to a writer starts a fresh window instead of inheriting the old count.
 *
 * @param {{ compared?: number, firstCompareAt?: string|null, lastDisagreedAt?: string|null }} row - A table's recorded counts.
 * @param {Date|string|number} now - The time to measure to.
 * @param {number} [hours] - The window length that counts as ready.
 * @returns {{ windowStart: string|null, windowHours: number, ready: boolean }}
 */
export function windowReport(row, now, hours = WINDOW_HOURS) {
  const times = [row.firstCompareAt, row.lastDisagreedAt].filter(Boolean).map(at => Date.parse(at)).filter(Number.isFinite);
  if (!(row.compared > 0) || !times.length) return { windowStart: null, windowHours: 0, ready: false };
  const start = Math.max(...times);
  const elapsed = Math.max(0, (new Date(now).getTime() - start) / 3_600_000);
  return { windowStart: new Date(start).toISOString(), windowHours: elapsed, ready: elapsed >= hours };
}
