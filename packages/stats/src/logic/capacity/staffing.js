/** The staffing rule: how many builder and review seats the board runs, 8 builders to 1 reviewer by default [C7]. */

/** Builders per reviewer when the caller names no ratio. */
export const STAFFING_RATIO = 8;

/**
 * The builder and review seats to run: builders are the ready items capped by the max useful builders when that is known,
 * and reviewers are one per `ratio` builders, rounded up, with at least one whenever any builder runs.
 *
 * @param {{ ready: number, maxUseful?: number | null, ratio?: number }} input the ready item count, the max useful builders (null when unknown) and the builders per reviewer
 * @returns {{ builders: number, reviewers: number, ratio: number }}
 */
export function staffingSeats({ ready, maxUseful = null, ratio = STAFFING_RATIO }) {
  const open = Number.isFinite(ready) && ready > 0 ? Math.floor(ready) : 0;
  const cap = Number.isFinite(maxUseful) && maxUseful >= 0 ? Math.floor(maxUseful) : open;
  const builders = Math.min(open, cap);
  const per = Number.isFinite(ratio) && ratio > 0 ? ratio : STAFFING_RATIO;
  return { builders, reviewers: builders > 0 ? Math.max(1, Math.ceil(builders / per)) : 0, ratio: per };
}

/**
 * The one status line naming the builder seats, the review seats and the ratio.
 *
 * @param {{ builders: number, reviewers: number, ratio: number }} seats the answer of staffingSeats
 * @returns {string}
 */
export function staffingLines(seats) {
  const noun = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  return `Staffing: ${noun(seats.builders, 'builder')}, ${noun(seats.reviewers, 'reviewer')} (${seats.ratio}:1)`;
}
