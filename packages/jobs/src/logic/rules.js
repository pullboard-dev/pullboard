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
