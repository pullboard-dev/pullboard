/** Canonical entry points for the verify cell; every moved body is exported here once [C7]. */
export * from './light.js';
export { normalizeReviewDefaults } from './src/io/review/default.js';
export { barActorForCommand, nativeBarActor, nativeBarActorForSeat, normalizeBarActor } from './src/io/bar/actor.js';
export { barCheckEnabled, barCheckFactFields, barCheckState, barCheckWarning } from './src/logic/bar/check.js';
export { barCoverageCommand, barCoverageDigest, barCoverageForPolicy, barTestPath, normalizeBarCoverage, prepareBarCoverage, previewBarCoverage } from './src/io/bar/coverage.js';
export { barDigest, barNotes, barReadiness, barReadinessRequired, barReadyProblem, recordBarRevision, setBarReady, signBar, barReadySetting } from './src/io/bar/readiness.js';
export { PROVES_NOTHING_HOLD, PROVES_NOTHING_HOLD_REASON, acceptCheck, checkAcceptCommand, checkAcceptance, checkDigest, provingCheck, refuseClaimProvesNothing, refuseProvesNothing } from './src/io/check/accept.js';
export { citedTestFiles, rowEvidence, rowStage } from './src/io/evidence.js';
export { barTestFiles, frozenBar, frozenRowGates, namedClause, wording } from './src/logic/frozen.js';
export { nextReview, ownSessionReviews, returnUnmergeable } from './src/logic/next.js';
export { completeMoveHandoff } from './src/logic/post/move.js';
export { recordNativeProof } from './src/logic/proof/native.js';
export { counterCaught, counterProofStats } from './src/io/proof/caught.js';
export { PROOF_COUNTER_PREFIX, appendProofCounter, clearProofCounters, currentProofCounters, ensureProofCounters, proofCounter, proofCounterRows, rebuildProofCounters } from './src/io/proof/counters.js';
export { refreshCapacityOutsideWrite } from './src/io/proof/counters.js';
export { tier1Shadow, tier1ShadowFields } from './src/logic/shadow.js';
export { observedFailureSignatures, proofCounts, proofFields, receiptFields, runTimingFields, sameEnvironment, testRuntimeEnvironment, testRuntimeRows } from './src/logic/proof/provenance.js';
export { anyRequiredReviewFamilyEngine, projectReviewFamily, requiredReviewFamily, requiredReviewFamilyEngine, requiredReviewFamilyProblem, saveReviewFamily, validateReviewFamily } from './src/logic/required.js';
export { eligibilityProblem, reviewEligibility } from './src/logic/review/eligibility.js';
export { committedItemAuthors, itemReviewPolicy, reviewFamilyProblem, reviewPolicyChange, saveItemReviewPolicy, strictReviewProblem, twoTierReviews } from './src/io/review/independence.js';
export { aliasEngineOn, anyItemReviewPolicyEngine, familiesDiffer, familyAliasesOf, familyIndex, familyName, itemReviewPolicyEngine } from './src/logic/review/policy.js';
export { reviewQueueLine } from './src/logic/review/queue.js';
export { canonicalFamily, overdueReview, prioritizeReviews, requireStrictBuilderFamily, reviewReleaseCooldown, reviewRoutingEnabled, reviewWait, seatFamily, strictReviewProblem as routingStrictReviewProblem, builderFamilyOf } from './src/io/review/routing.js';
export { ruleProofCounts, ruleProofWindow } from './src/io/rule/proof/counts.js';
export { bindProofRunner, committedRuleCoverage, proofCoverageFingerprint } from './src/io/rule/proof/coverage.js';
export { appendRuleProof } from './src/io/rule/proof/append.js';
export { advancedVerdict, effectiveItemHead, requireSourceAdvanceReview, sourceAdvanceChain, sourceAdvanceEpisode, sourceAdvanceFloor, sourceAdvanceReviewEpisode } from './src/logic/advance.js';
export { composeReview, composesAtAdmission } from './src/io/verdict/admission.js';
export { recordVerdict, reviewAssurance, verdictAssurance } from './src/logic/verdict/assurance.js';
export { cachedVerdictStates, captureVerdictReview, composesUnchanged, staleVerdictRefusal, verdictProjector, verdictTrunk } from './src/io/verdict/freshness.js';
export { retryReviewCommit } from './src/logic/verdict/retry.js';
export { acceptedVerdict, checkedLandingCommit, verdictReviewProblem, verdictsFor } from './src/logic/verdict/reviews.js';
export { judgeTrunkMove } from './src/io/verdict/trunk.js';
export { itemTrunkMove } from './src/io/verdict/trunk.js';
export { checkOptions, verdictWithdrawalTarget, verdictWithdrawals } from './src/io/verdict/withdrawal.js';
export { finishVerdict, rejectionClauseDetail, rejectionClauseProblem, sharpenRepeatedClause } from './src/io/rejection.js';
export { classifiedStrict, gateJudgmentItem, gateJudgmentPath, reviewTierFloor } from './src/io/review/tier.js';
export { editCheck, selfWidenedFiles, widenedCheckFiles } from './src/io/check/widen.js';
export { asSubmitted, refuseUnreviewable, unreviewableStrict } from './src/logic/review/reachability.js';
export { compositionAuthors, compositionFamilyFallback, compositionOwner, compositionReviews, compositionSessionOptions, reviewPatchAuthors } from './src/io/review/composition.js';
export { blockingFailures, landingGateRecords, nativeProofBlockingGreen, quarantineBatchGates, quarantineVerdict, quarantineVerdictFields, receiptBlockingGreen } from './src/logic/verdict/quarantine.js';
export { CHECK_ACCEPT_ENGINE } from '../state/light.js';

export { refuseManualCheckBaseline } from './src/logic/baseline.js';
export { comparisonRestartPlan, COMPARISON_RESTART_LIMIT } from './src/io/compare.js';
export { compareVerification, comparisonCommand, renderVerificationComparison, recordedVerificationComparison, VERIFICATION_COMPARISON_PREFIX } from './src/io/compare.js';

export { launchComparisonWorker } from './src/io/comparison.js';
export { prepareComparison } from './src/io/comparison.js';

export { machineBarDigest, machineClauseCommands, machineProofProblem } from './src/logic/verdict/machine.js';
export { machineVerification, validateMachineVerification, saveMachineVerification, machineVerificationEligible, acceptMachineSubmission } from './src/io/machine.js';
export { submitReusePlanDigest } from './src/logic/plan.js';

export { kernelGateChange, kernelApprovalText, requireKernelApproval } from './src/io/kernel.js';
export { recordReviewPacket, reviewPacketLines, reviewPacketReadNote, reviewPacketRerun, showReviewPacket } from './src/io/review/packet.js';

export { reusableSubmitProof, submittedPolicyCommit } from './src/io/reuse.js';
export { sealedMoveOverlap } from './src/io/verdict/trunk.js';
export { carriesBarReason, barCorrectionFields, barCorrections, barCorrectionLine, barStatsLines, readBarState } from './src/logic/bar/corrections.js';
