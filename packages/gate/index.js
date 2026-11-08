/** gate front door: the cell's public modules behind one entry [C7,CD60]. */
export { removeTestSandbox } from "./src/shell/test-sandbox-cleanup.js";
export { CLEAN_GATES_TO_ENFORCE, ENFORCED_REFUSALS, CHANGED_REFUSALS, refusalTrialFile, refusalMode, trialRefusal, gateRefuse, countTrialGate, recordFalseRefusal } from "./src/shell/refusal-trial.js";
export { machineryRefusal, runMachineryGuard } from "./src/shell/refusal-trial.js";
export { sealKnownMainAutofile } from "./src/shell/known-main-autofile-receipts.js";
export { declaredSourceLoads, declaredSourcePatterns, testClosures, codeMapGraph, selectTestTreeGuards, selectAffectedTests } from "./src/shell/affected-tests.js";
export { packageBranchCoverage } from "./src/shell/audit-coverage.js";
export { resolveExecutable, checkNeedsBrowser, explicitCheckFiles, testsNeedBrowser, browserBoundFiles, literalShellWords, BROWSER_MARKER } from "./src/shell/browser-admission.js";
export { browserSlotRefusal, isBrowserExecutable, browserInCall, installBrowserSlotGuard, BROWSER_SLOT_ENV } from "./src/shell/browser-slot-guard.js";
export { landedBatchCount, capacitySummary, declaredTestBoundary } from "./src/core/capacity-summary.js";
export { sayCheckBaseline, provingCheck } from "./src/core/check-baseline-format.js";
export { retryCheckBaselines, startCheckBaseline, runCheckBaselineWorker } from "./src/shell/check-baseline-worker.js";
export { checkBaseline, baselineTestEvidence, baselineFailureDetails, refuseCheckSyntax, prepareCheckBaseline } from "./src/shell/check-baseline.js";
export { exactStart, childJournalPreloadSource } from "./src/shell/child-journal-preload.js";
export { chromeCloneDirectories, chromeCloneSnapshot, newChromeClones } from "./src/shell/chrome-clone-check.js";
export { testsNeedCpuRunner, cpuRunnerRequired } from "./src/shell/cpu-load-admission.js";
export { detectGate, settingCommand, missingGate, setHere } from "./src/shell/gate-config.js";
export { recordGateRun, gateRuns, gateControlFindings, GATE_RUNS_FILE, GATE_WINDOW_MS, GATE_MIN_RUNS } from "./src/shell/gate-control.js";
export { committedTree, isStampedGreen, refuseSandboxBlocked, safeLog, runProfiledShell, runFrozenProof, runProfiledShellAsync, withLandingGateSlot, landingControllerPlacement, pinRunMain, runGate, runMainComparison, recordRun, fullGateRun } from "./src/shell/gate-execution.js";
export { digestOf, writeTimingProfile } from "./src/shell/gate-output.js";
export { runnerSource, RunnerDropped, validateRunner } from "./src/core/gate-policy-load.js";
export { receiptLog, startReceipt, slotOf, phasesOf, receiptOf, recordReceipt, recentReceipts, retainedReceipts, receiptStats, receiptStatsLines, receiptLine, gateWaitStats } from "./src/shell/gate-receipt.js";
export { receiptStore, boardReceiptStore, receiptBody, readGateReceipt, receiptBinds, formatCollectionReport, parseCollectionReports, releaseParticipation, landingShardProfile, RECEIPT_FOLDER, COLLECTION_ID_ENV, COLLECTION_REPORT_PREFIX, RELEASE_EXECUTORS_ENV, RELEASE_PARTICIPATION_PREFIX, receiptFields } from "./src/shell/gate-run-receipt.js";
export { requireGateExecutionServices, settleReceipt, withGateSlot, gateRunnerLoadPolicy, withAvoidedRunners, preferOtherRunners } from "./src/shell/gate-slot.js";
export { gateStages, stagedScript, readPipes, readStages } from "./src/shell/gate-stages.js";
export { submitGateConfig, submitGatePlan, submitGateAdmission, runSubmitGate } from "./src/shell/gate-submit.js";
export { gateWaitReporter } from "./src/core/gate-wait.js";
export { performanceCores, testConcurrency, landingShardCount, runShell, sandboxBlockedOperation, sandboxBlockedScanner, runStaticChecks, deferredSelectionNote, submitGateReport, timingDigest, gateReport } from "./src/shell/gate.js";
export { testsNeedGui, projectNeedsGui, checkNeedsGui } from "./src/shell/gui-admission.js";
export { guiSession } from "./src/shell/gui-session.js";
export { mainMovedSinceAudit, nudgeMainAudit } from "./src/shell/main-audit-nudge.js";
export { scheduleMainAudit, waitMainAudit } from "./src/shell/main-audit-scheduler.js";
export { mainAuditDirectory, activateMainAudits, mainAuditKey, readMainAudit, saveMainAudit } from "./src/shell/main-audit-state.js";
export { runMainAudits, mainAuditJobs, routeAuditFailures, closeAuditedMainReds, withAuditedMain } from "./src/shell/main-audit-worker.js";
export { attributeAuditFailures, fileAuditRegressions, auditRegressionTitle, auditRegressionNote } from "./src/shell/main-audit-attribution.js";
export { withImportParseCache } from "./src/shell/module-import-cache.js";
export { withParseScope, importsIn, commonJsIn, cpuLiteralCache, cpuRegistrationExportsIn, cpuCallableExportsIn, cpuLoadOptionsIn } from "./src/shell/module-imports.js";
export { readPerfReport, evaluatePerfBudgets, perfBudgetTable, PERF_INTERACTIONS, PERF_BUDGETS } from "./src/core/perf-budgets.js";
export { releaseParticipationFields, releaseParticipationDigest, releaseReceiptProblem, releaseReceiptFields, releaseReceiptBody, readReleaseReceipt, RELEASE_RECEIPT_MAX_BYTES } from "./src/shell/release-gate-receipt.js";
export { releaseSource, verifyNativeReleaseReceipt, runReleaseGate } from "./src/shell/release-gate.js";
export { ReleaseTransportError, unpackReleaseReceipt, GitHubReleaseTransport, readGitHubReleaseReceipt, latestGitHubReleaseRun } from "./src/shell/release-transport.js";
export { importStyleViolations } from "./src/shell/static-import-style.js";
export { tapTests, committedTest } from "./src/shell/tap-tests.js";
export { testActionKeys, testResultStore, reusableResult, suiteProven, planTestActions, settleTestActions, recordTestAction, TEST_ACTIONS_ENV, TEST_STAGE_ENV } from "./src/shell/test-action-cache.js";
export { prepareTestResultExchange } from "./src/shell/test-action-transfer.js";
export { testCapacityReport } from "./src/shell/test-capacity.js";
export { testConversionPlan } from "./src/core/test-conversion.js";
export { validatePlacementIndex, readPlacementIndex, readPlacementReport, writePlacementIndex, indexedStageSelection } from "./src/shell/test-economics-index.js";
export { testValueCosts, journeyReason, placeTest, placementReport, testsAtStage, auditInterval, incrementalAudit, mainRedCheckFiles, mainRedFrozenCheck, mainRedFilesProven, TEST_VALUE_DEFAULTS, auditFailureItem } from "./src/shell/test-economics.js";
export { dispatchTestFiles, reportDispatchedTests, nativeFileArguments, testFileOptions, optionTakesValue, knownNodeOption, legacyFileMode, legacyNativeFileRun } from "./src/shell/test-file-dispatch.js";
export { testFilePool, testFilePoolValue, occupiedPlaces, takeTestFileToken, reserveTestFileToken, awaitNestedRun, longestFirst, TEST_FILE_POOL_ENV, TEST_FILE_CORES_ENV } from "./src/shell/test-file-pool.js";
export { isolateTestMachine, foreignNodeOptions, ACCOUNT_HOME_ENV, RUNNER_PRELOAD_ENV } from "./src/shell/test-isolation.js";
export { testOutcomeCollector, formatTestOutcomes, readTestOutcomes, committedTestOutcomes, trailer, notify, testOutcomeFields } from "./src/shell/test-outcomes.js";
export { refreshTestPlacement } from "./src/shell/test-placement-report.js";
export { testWord, paidTests, placementSubmitSelection, valueGateCommand, placementLandingGate, placementLandingPlan, VALUE_GATE } from "./src/shell/test-placement.js";
export { testResultDigest, validTestTap, validTestResult, storeTestResult, selectedTestResults, packTestResults, importTestResults, completedTestResult, retainTestResultCompletion, TEST_RESULT_VERSION, TEST_RESULT_STORE_ENV, TEST_RESULT_ORIGIN_ENV, TEST_RESULT_REQUEST_ENV } from "./src/shell/test-result-store.js";
export { runFullSuite, testFiles, runTestFiles } from "./src/shell/test-run.js";
export { testSelectionPatterns, narrowsSelection, landingShardOptions, landingFanOutFiles, shardSelectionMatched, SHARD_SELECTED_LINE, selectedTestResult, isGitWorkTree, trackedDefaultTestFiles, shardArguments, hasTestFiles, explicitTestFiles, isDefaultTestFile, default as testSelectionDefault } from "./src/shell/test-selection.js";
export { readTestValueTimings, retainTestValueTimings, fileTimesPath, readFileTimes } from "./src/shell/test-value-timing.js";
export { testValueReport } from "./src/shell/test-value.js";
export { runTimedShell } from "./src/shell/timed-shell-worker.js";
export { timingRunner, timingFromOutput, logLines, timingFromLog, runnerPhaseFields, runnerPhaseLine, startRunnerPhases } from "./src/shell/timing.js";
export { timingSource, sameTimingSource, suiteTimingFields, formatSuiteTiming, suiteTimingFromOutput, timingAccountingOutput, timingAccountingStages, observedRunTiming, beginSuiteTiming, TIMING_RUN_ID_ENV, SUITE_TIMING_PREFIX } from "./src/shell/run-timing.js";
export { failedAssertionLines, retainedGateAssertions, testOutputSummary, retainTestOutput, renderTestSummary, summaryProfile, withTestOutput } from "./src/shell/test-output-summary.js";
export { cachedAffectedGraph } from "./src/shell/affected-graph-cache.js";
export { checkCoordinatorRelease, recordCoordinatorRelease, readCoordinatorRelease } from './src/shell/coordinator-release.js';
export { TEST_TIERS_FILE, generateTestTiers, formatTestTiers, writeTestTiers } from './src/shell/test-tiers.js';

export { reviewCitations, citedReceiptsNote, citedReceipts, landingRunFiles } from './src/shell/prove-once.js';
export { redGateScope, redGateReport, runnerErrors } from './src/shell/red-gate-report.js';
export { requireTestTierAccount, requireSealedSkips, hasTestTiers, selectTestTiers, testTierProofFiles, testTierCommand, testTierCheckCommand, testTierReport } from './src/shell/test-tier-selection.js';
export { testRunPhaseClock } from './src/shell/test-run-phases.js';

export { testTimeBudget, testTimeBudgetLines } from './src/core/test-time-budget.js';

export { runGateStages } from "./src/core/gate-stages.js";
export { packageHashesAt, unsealedPackages, sealStoreFile, recordSeal, sealOf, sealStatus, checkSkippedSeals } from './src/shell/seals.js';

export { privateCheckAdmission } from './src/shell/private-check-admission.js';
export {
  DEFAULT_TEST_FILE_TIMEOUT_MS,
  TEST_CHILD_CLEANUP_FAILED,
  testFileTimeoutMs,
  activeHandleSummary,
  installTestChildDrain,
} from './src/shell/test-child-drain.js';
export { gateMachineHome, gateRuntimeCaptureSource } from './src/core/preload-policy.js';
export { changedStaticFailures, stagedHookFailures } from './src/shell/changed-static.js';
export { STATIC_CHECKS, runStaticRegistry } from './src/shell/static-check-registry.js';
export { fixedWallMargins, wallClockViolations } from './src/shell/wall-clock-budgets.js';
export { acceptedCellsIdentity, toolingIsPinned, readAcceptedCells, warmAcceptedCells, nudgeAcceptedCells, recordAcceptedCellsFailure, waitForAcceptedCells } from './src/shell/accepted-cells-inventory.js';
export { LOAD_BEARING_CEILINGS, LOAD_BEARING_CELLS, loadBearingJudged, loadBearingSites, loadBearingCounts, loadBearingGrowth, loadBearingRaised, loadBearingFailures } from "./src/core/load-bearing.js";
