/**
 * Verify read door: the verdict reads a board query, list or status projects with, without the review and landing shells.
 * Not light.js, which the runner worker bundles: these reads reach the items and state cells the worker never needs [C7].
 */
export { effectiveItemHead } from './src/logic/advance.js';
export { projectReviewFamily } from './src/logic/required.js';
export { verdictWithdrawals } from './src/io/verdict/withdrawal.js';
export { acceptedVerdict, verdictReviewProblem, verdictReads, verdictsFor } from './src/logic/verdict/reviews.js';
export { staleVerdictRefusal, verdictProjector, verdictTrunk } from './src/io/verdict/freshness.js';
export { familyIndex } from './src/logic/review/policy.js';

/**
 * The verify reads pullboard show calls, each from its defining module, loaded only when show asks for them.
 * Why lazy: list, status, next and claim load this door too, so a static export here would add show's modules to their cold paths [C7,#11911].
 *
 * @returns {Promise<Record<string, Function>>} The eleven show reads by name.
 */
export async function showReads() {
  const { recordedVerificationComparison, renderVerificationComparison } = await import('./src/io/compare.js');
  const { machineVerification } = await import('./src/io/machine.js');
  const { testHashRulings, testAuthors } = await import('./src/logic/testHashes.js');
  const { barTestFiles } = await import('./src/logic/frozen.js');
  const { verdictTrunk } = await import('./src/io/verdict/freshness.js');
  const { reviewEligibility } = await import('./src/logic/review/eligibility.js');
  const { barCorrectionLine, barCorrections } = await import('./src/logic/bar/corrections.js');
  return { recordedVerificationComparison, renderVerificationComparison, machineVerification, testHashRulings, testAuthors, barTestFiles, verdictTrunk, reviewEligibility, barCorrectionLine, barCorrections };
}

/** pullboard show --review: the review packet module loads only for that flag [C7,#11911]. */
export async function showReviewPacket(...call) {
  return (await import('./src/io/review/packet.js')).showReviewPacket(...call);
}
