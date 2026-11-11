/** Pure naming for the landing jobs that `pullboard merged` and `pullboard land` drive through the finish sequence [C7]. */

/** The job kind every landing batch row carries (RFC 0008 DJ11). */
export const LANDING_JOB_KIND = 'landing';

/**
 * The job id of a hand landing: the items `pullboard merged` records and the commit they landed as.
 *
 * Why: the id is the idempotency key. A second `merged` for the same items and commit finds the same row, so a
 * killed run resumes from its saved steps and a finished one answers the same commit without a second event.
 *
 * @param {number[]} ids - The item ids, first named first.
 * @param {string} commit - The landed commit.
 * @returns {string}
 */
export function mergedLandingJobId(ids, commit) {
  return `land:merged:${ids.join(',')}:${commit}`;
}

/**
 * The job id of a batch landing recorded by `pullboard land`.
 *
 * @param {string} batch - The landing batch id.
 * @returns {string}
 */
export function batchLandingJobId(batch) {
  return `land:batch:${batch}`;
}
