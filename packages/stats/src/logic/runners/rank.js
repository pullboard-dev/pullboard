/** Nearest-rank percentiles for the runner statistics [C7]. */

/**
 * Nearest-rank percentile of a sorted list: the smallest value with at least `share` of the list at or below it.
 *
 * Why: it always returns a measured number, never an interpolated one, so a seeded journey has an exact answer.
 *
 * @param {number[]} sorted - ascending
 * @param {number} share - 0 to 1
 * @returns {number|null}
 */
export function nearestRank(sorted, share) {
  if (!sorted.length) return null;
  return sorted[Math.max(1, Math.ceil(share * sorted.length)) - 1];
}
