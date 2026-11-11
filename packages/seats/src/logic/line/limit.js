/** One pure total-WIP cap for recorded native decisions and counterfactual replay [N2,R1,H16]. */
/** The recorded controller currently observes review activity over one hour; a future setting is separate. */
export const ACTIVE_REVIEWER_WINDOW_MINUTES = 60;

/**
 * Return the cap from an already validated line-setting ratio and observed distinct reviewer count.
 * Off has no cap; an empty observation window uses one reviewer. Fractional caps are not rounded:
 * the next integer item may enter only while the resulting total stays at or below this number.
 * @param {number|false} ratio
 * @param {number} activeReviewers - Nonnegative integer from the shared observation window.
 * @returns {number|null}
 */
export function lineWipLimit(ratio, activeReviewers) {
  return ratio === false ? null : ratio * Math.max(1, activeReviewers);
}
