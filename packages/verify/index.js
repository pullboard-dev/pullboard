/** Canonical entry points for the verify cell; every moved body is exported here once [C7]. */
export { normalizeReviewDefaults } from './src/shell/review-default.js';
export { barActorForCommand, nativeBarActor, nativeBarActorForSeat, normalizeBarActor } from './src/shell/bar-actor.js';
export { barCheckEnabled, barCheckFactFields, barCheckState, barCheckWarning } from './src/core/bar-check.js';
export { barCoverageCommand, barCoverageDigest, barCoverageForPolicy, barTestPath, normalizeBarCoverage, prepareBarCoverage, previewBarCoverage } from './src/shell/bar-coverage.js';
export { barDigest, barNotes, barReadiness, barReadinessRequired, barReadyProblem, recordBarRevision, setBarReady, signBar, barReadySetting } from './src/shell/bar-readiness.js';
export { PROVES_NOTHING_HOLD, acceptCheck, checkAcceptCommand, checkAcceptance, checkDigest, provingCheck, refuseClaimProvesNothing, refuseProvesNothing } from './src/shell/check-accept.js';
export { citedTestFiles, rowEvidence, rowStage } from './src/shell/evidence.js';
export { barTestFiles, frozenRowGates } from './src/core/frozen-clause.js';
export { nextReview, ownSessionReviews, returnUnmergeable } from './src/core/next-review.js';
export { completeMoveHandoff } from './src/core/post-move-handoff.js';
export { recordNativeProof } from './src/core/proof-cli.js';
export { counterCaught, counterProofStats } from './src/shell/proof-counter-read.js';
export { PROOF_COUNTER_PREFIX, appendProofCounter, clearProofCounters, currentProofCounters, ensureProofCounters, proofCounter, proofCounterRows, rebuildProofCounters } from './src/shell/proof-counters.js';
export { refreshCapacityOutsideWrite } from './src/shell/proof-counters.js';
export { tier1Shadow, tier1ShadowFields } from './src/core/tier1-shadow.js';
export { observedFailureSignatures, proofCounts, proofFields, receiptFields, runTimingFields, sameEnvironment, testRuntimeEnvironment, testRuntimeRows } from './src/core/proof-provenance.js';
export { anyRequiredReviewFamilyEngine, projectReviewFamily, requiredReviewFamily, requiredReviewFamilyEngine, requiredReviewFamilyProblem, saveReviewFamily, validateReviewFamily } from './src/core/required-review-family.js';
export { eligibilityProblem, reviewEligibility } from './src/core/review-eligibility.js';
export { committedItemAuthors, itemReviewPolicy, reviewFamilyProblem, reviewPolicyChange, saveItemReviewPolicy, strictReviewProblem, twoTierReviews } from './src/shell/review-independence.js';
export { aliasEngineOn, anyItemReviewPolicyEngine, familiesDiffer, familyAliasesOf, familyIndex, familyName, itemReviewPolicyEngine } from './src/core/review-policy.js';
export { reviewQueueLine } from './src/core/review-queue-line.js';
export { canonicalFamily, overdueReview, prioritizeReviews, requireStrictBuilderFamily, reviewReleaseCooldown, reviewRoutingEnabled, reviewWait, seatFamily, strictReviewProblem as routingStrictReviewProblem } from './src/shell/review-routing.js';
export { ruleProofCounts, ruleProofWindow } from './src/shell/rule-proof-counts.js';
export { committedRuleCoverage, proofCoverageFingerprint } from './src/shell/rule-proof-coverage.js';
export { appendRuleProof } from './src/shell/rule-proof-index.js';
export { advancedVerdict, effectiveItemHead, requireSourceAdvanceReview, sourceAdvanceChain, sourceAdvanceEpisode, sourceAdvanceFloor, sourceAdvanceReviewEpisode } from './src/core/source-advance-state.js';
export { composeReview, composesAtAdmission } from './src/shell/verdict-admission.js';
export { recordVerdict, reviewAssurance, verdictAssurance } from './src/core/verdict-assurance.js';
export { cachedVerdictStates, captureVerdictReview, composesUnchanged, staleVerdictRefusal, verdictProjector, verdictTrunk } from './src/shell/verdict-freshness.js';
export { retryReviewCommit } from './src/core/verdict-retry.js';
export { acceptedVerdict, checkedLandingCommit, verdictReviewProblem, verdictsFor } from './src/core/verdict-reviews.js';
export { judgeTrunkMove } from './src/shell/verdict-trunk.js';
export { itemTrunkMove } from './src/shell/verdict-trunk.js';
export { checkOptions, verdictWithdrawalTarget, verdictWithdrawals } from './src/shell/verdict-withdrawal.js';
export { finishVerdict, rejectionClauseDetail, rejectionClauseProblem, sharpenRepeatedClause } from './src/shell/reject-clause.js';
export { classifiedStrict, gateJudgmentItem, gateJudgmentPath, reviewTierFloor } from './src/shell/review-tier.js';
export { editCheck, selfWidenedFiles, widenedCheckFiles } from './src/shell/check-widen.js';
export { asSubmitted, refuseUnreviewable, unreviewableStrict } from './src/core/review-reachability.js';
export { compositionAuthors, compositionFamilyFallback, compositionOwner, compositionReviews, compositionSessionOptions, reviewPatchAuthors } from './src/shell/review-composition.js';
export { blockingFailures, landingGateRecords, nativeProofBlockingGreen, quarantineBatchGates, quarantineVerdict, quarantineVerdictFields, receiptBlockingGreen } from './src/core/quarantine-verdict.js';
export { CHECK_ACCEPT_ENGINE } from '../../src/move-engine-constants.js';

export { refuseManualCheckBaseline } from './src/core/check-baseline-automatic.js';
export { DEFAULT_FILE_WALL_MS, DEFAULT_FILE_IDLE_MS, fileWatchdogLimits, fileIdleHung, wallLoadFactor } from './src/core/file-watchdog-policy.js';
export { installFileWatchdog } from './src/shell/file-watchdog.js';
export { comparisonRestartPlan, COMPARISON_RESTART_LIMIT } from './src/shell/verify-compare.js';
export { compareVerification, comparisonCommand, renderVerificationComparison, recordedVerificationComparison, VERIFICATION_COMPARISON_PREFIX } from './src/shell/verify-compare.js';

export { launchComparisonWorker } from './src/shell/comparison-worker.js';

export { machineBarDigest, machineClauseCommands, machineProofProblem } from './src/core/machine-verdict.js';
export { machineVerification, validateMachineVerification, saveMachineVerification, machineVerificationEligible, acceptMachineSubmission } from './src/shell/machine-verification.js';
export { submitReusePlanDigest } from './src/core/submit-reuse-plan.js';

export { kernelGateChange, kernelApprovalText, requireKernelApproval } from './src/shell/kernel-gate.js';
export { recordReviewPacket, reviewPacketLines, reviewPacketReadNote, reviewPacketRerun, showReviewPacket } from './src/shell/review-packet.js';

export { reusableSubmitProof } from './src/shell/submit-proof-reuse.js';
