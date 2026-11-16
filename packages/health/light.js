/** @pullboard-module-loads packages/health/src/io/stale/state/capture.js */
/** The health calls claim, release and next make, without the doctor, main health, landing and map loads the cell index also brings [C7,#7081]. */
import { createRequire } from 'node:module';
/** The review-cover shout and its pause tail, for next's selection and reasons. */
export { shoutReviewCoverStuck, REVIEW_COVER_PAUSE_TAIL } from './src/io/cover.js';

const requireModule = createRequire(import.meta.url);
/** The stale-state capture, loaded at the first claim or release that captures: next reads the cover shout and never pays for it. */
const capture = () => requireModule('./src/io/stale/state/capture.js');

/**
 * Capture the lapsed claims before a claim's write.
 *
 * @param {...any} args - As capture.js captureLapsedClaims.
 * @returns {any}
 */
export function captureLapsedClaims(...args) { return capture().captureLapsedClaims(...args); }

/**
 * Pin a released claim's work at a board ref.
 *
 * @param {...any} args - As capture.js pinClaimHandoff.
 * @returns {any}
 */
export function pinClaimHandoff(...args) { return capture().pinClaimHandoff(...args); }
