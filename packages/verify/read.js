/**
 * Verify read door: the verdict reads a board query, list or status projects with, without the review and landing shells.
 * Not light.js, which the runner worker bundles: these reads reach the items and state cells the worker never needs [C7].
 */
export { effectiveItemHead } from './src/logic/advance.js';
export { projectReviewFamily } from './src/logic/required.js';
export { verdictWithdrawals } from './src/io/verdict/withdrawal.js';
export { acceptedVerdict, verdictReviewProblem, verdictReads, verdictsFor } from './src/logic/verdict/reviews.js';
export { staleVerdictRefusal, verdictProjector } from './src/io/verdict/freshness.js';
export { familyIndex } from './src/logic/review/policy.js';
