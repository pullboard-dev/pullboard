/** The minutes each stage may last, read from the board settings that already govern it, so the view marks a stage past its limit without a constant of its own [#6940]. */

/** Whole or fractional minutes from a millisecond setting, or null when the setting is absent. */
function minutesOf(ms) {
  return Number.isFinite(ms) && ms > 0 ? ms / 60_000 : null;
}

/**
 * Minutes per stage for the board snapshot. A stage whose setting is absent is left out, never given a default,
 * so the view shows no past-limit mark for it.
 *
 * building: itemBuildBudgetMinutes; gate: check.timeout; pending review: review.starveMinutes;
 * in review: reviewLease; landing: landing.timeout when set.
 *
 * @param {any} config a loaded board config
 * @returns {{ building?: number, gate?: number, 'pending review'?: number, 'in review'?: number, landing?: number }}
 */
export function stageLimits(config) {
  const limits = {
    building: config?.itemBuildBudgetMinutes,
    gate: minutesOf(config?.check?.timeoutMs),
    'pending review': config?.review?.starveMinutes,
    'in review': minutesOf(config?.reviewLeaseMs),
    landing: minutesOf(config?.landing?.timeoutMs),
  };
  return Object.fromEntries(Object.entries(limits).filter(([, minutes]) => Number.isFinite(minutes) && minutes > 0));
}
