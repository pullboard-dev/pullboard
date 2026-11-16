/** Pure lease constants and checks for the job store [C7]. */

/** A lease silent this long frees its job: the liveness invariant's 2 minutes. */
export const LEASE_MS = 120_000;

/**
 * True when a job's lease has lapsed at `now`, so any driver may take it.
 *
 * @param {number} leaseUntil - Epoch milliseconds the lease runs to; 0 for a job never taken.
 * @param {number} now - Epoch milliseconds.
 * @returns {boolean}
 */
export function leaseLapsed(leaseUntil, now) {
  return leaseUntil < now;
}

// Budget: a queued job nobody can claim is stale after this long per kind; the three kinds that piled up on 15 Nov. A kind not listed never expires.
export const QUEUED_EXPIRY_MS = Object.freeze({ gate: 6 * 3_600_000, land: 24 * 3_600_000, 'flake-diagnose': 12 * 3_600_000 });

/**
 * True when a queued job has outlived its kind's limit with nothing waiting on it.
 *
 * Why: jobs left in `queued` are never offered, so they hide the real backlog; a waiter's `alive` mark keeps one.
 *
 * @param {string} kind
 * @param {number} quietSince - Epoch milliseconds of its creation or the last waiter's mark, whichever is later.
 * @param {number} now - Epoch milliseconds.
 * @returns {boolean}
 */
export function queuedExpired(kind, quietSince, now) {
  const limit = QUEUED_EXPIRY_MS[kind];
  return limit !== undefined && now - quietSince > limit;
}
