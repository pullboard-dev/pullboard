/** gate front door: the cell's public modules behind one entry [C7,CD60]. */
export * from "./light.js";
export { removeTestSandbox } from "./src/io/test/cleanup.js";
export { CLEAN_GATES_TO_ENFORCE, ENFORCED_REFUSALS, CHANGED_REFUSALS, refusalTrialFile, refusalMode, trialLedgerKey, trialRefusal, gateRefuse, countTrialGate, recordFalseRefusal } from "./src/io/refusal/trial.js";
export { machineryRefusal, runMachineryGuard } from "./src/io/refusal/trial.js";
export { sealKnownMainAutofile } from "./src/io/receipts.js";
export { recordGateVerdict, finishAwaitingVerdicts, returnMainTest, judgeMainOwnedReds, freshMainReceipt, returnedMainReceipts, gateVerdictJobId, GATE_VERDICT_KIND, AWAITING_MAIN_STEP, MAIN_TEST_RECEIPT_STEP } from "./src/io/main/verdict.js";
export { testClosures, codeMapGraph, cliReachRows, keylessRows, selectTestTreeGuards, selectAffectedTests } from "./src/io/affected/tests.js";
export { CLI_FRONT_DOORS, packageCliReach } from "./src/logic/reach.js";
export { packageBranchCoverage } from "./src/io/coverage.js";
export { resolveExecutable, checkNeedsBrowser, explicitCheckFiles, testsNeedBrowser, browserBoundFiles, literalShellWords, BROWSER_MARKER } from "./src/io/browser/admission.js";
export { browserSlotRefusal, isBrowserExecutable, browserInCall, installBrowserSlotGuard, BROWSER_SLOT_ENV } from "./src/io/browser/guard.js";
export { landedBatchCount, capacitySummary, declaredTestBoundary } from "./src/logic/summary.js";
export { sayCheckBaseline, provingCheck } from "./src/logic/format.js";
export { retryCheckBaselines, startCheckBaseline, runCheckBaselineWorker } from "./src/io/check/baseline/worker.js";
export { checkBaseline, baselineTestEvidence, baselineFailureDetails, refuseCheckSyntax, refuseCheckPullboardTest, prepareCheckBaseline } from "./src/io/check/baseline.js";
export { exactStart, childJournalPreloadSource } from "./src/io/journal/preload.js";
export { chromeCloneDirectories, chromeCloneSnapshot, newChromeClones } from "./src/io/clone.js";
export { testsNeedCpuRunner, cpuRunnerRequired } from "./src/io/admission/cpu/load.js";
export { detectGate, settingCommand, missingGate, setHere } from "./src/io/config.js";
export { recordGateRun, gateRuns, gateControlFindings, GATE_RUNS_FILE, GATE_WINDOW_MS, GATE_MIN_RUNS } from "./src/io/control.js";
export { committedTree, isStampedGreen, stampGreen, refuseSandboxBlocked, safeLog, runProfiledShell, runFrozenProof, runProfiledShellAsync, withLandingGateSlot, landingControllerPlacement, pinRunMain, runGate, runMainComparison, recordRun, fullGateRun } from "./src/io/execution.js";
export { digestOf, writeTimingProfile } from "./src/io/output.js";
export { failureSignature } from "./src/logic/failure/signature.js";
export { runnerSource, RunnerDropped, validateRunner } from "./src/logic/policy.js";
export { receiptLog, startReceipt, slotOf, phasesOf, receiptOf, recordReceipt, recentReceipts, retainedReceipts, receiptStats, receiptStatsLines, receiptLine, gateWaitStats } from "./src/io/receipt.js";
export { receiptStore, boardReceiptStore, receiptBody, readGateReceipt, receiptBinds, formatCollectionReport, parseCollectionReports, releaseParticipation, landingShardProfile, RECEIPT_FOLDER, COLLECTION_ID_ENV, COLLECTION_REPORT_PREFIX, RELEASE_EXECUTORS_ENV, RELEASE_PARTICIPATION_PREFIX, receiptFields } from "./src/io/run/receipt.js";
export { requireGateExecutionServices, settleReceipt, withGateSlot, gateRunnerLoadPolicy, withAvoidedRunners, preferOtherRunners } from "./src/io/slot.js";
export { INFRASTRUCTURE_CODES, INFRA_RETRIES, LOCK_CODES, LOCK_WAIT_LIMIT, INVENTORY_WAITS, infrastructureFailure, submitUntilSettled } from "./src/io/requeue.js";
export { gateStages, stagedScript, readPipes, readStages } from "./src/io/stages.js";
export { submitGateConfig, submitGatePlan, submitGateAdmission, runSubmitGate, startCriterionRun, submitLogPath, startDiagnostics, namedFileRunner } from "./src/io/submit.js";
export { gateWaitReporter } from "./src/logic/wait.js";
export { recordGreenRun } from "./src/io/shards/green.js";
export { PULLED_JOB_ENV } from "./src/io/test/concurrency.js";
export { performanceCores, testConcurrency, landingShardCount, runShell, sandboxBlockedOperation, sandboxBlockedScanner, runStaticChecks, deferredSelectionNote, submitGateReport, timingDigest, gateReport } from "./src/io/main.js";
export { testsNeedGui, projectNeedsGui, checkNeedsGui } from "./src/io/gui/admission.js";
export { guiSession } from "./src/io/gui/session.js";
export { mainMovedSinceAudit, nudgeMainAudit } from "./src/io/main/audit/nudge.js";
export { scheduleMainAudit, waitMainAudit } from "./src/io/main/audit/scheduler.js";
export { mainAuditDirectory, activateMainAudits, mainAuditKey, readMainAudit, saveMainAudit } from "./src/io/main/audit/state.js";
export { runMainAudits, mainAuditJobs, routeAuditFailures, closeAuditedMainReds, withAuditedMain } from "./src/io/main/audit/worker.js";
export { attributeAuditFailures, fileAuditRegressions, auditRegressionTitle, auditRegressionNote } from "./src/io/main/audit/attribution.js";
export { withImportParseCache } from "./src/io/imports.js";
export { importsIn, commonJsIn, cpuLiteralCache, cpuRegistrationExportsIn, cpuCallableExportsIn, cpuLoadOptionsIn } from "../codemap/index.js";
export { readPerfReport, evaluatePerfBudgets, perfBudgetTable, PERF_INTERACTIONS, PERF_BUDGETS } from "./src/logic/budgets.js";
export { releaseParticipationFields, releaseParticipationDigest, releaseReceiptProblem, releaseReceiptFields, releaseReceiptBody, readReleaseReceipt, RELEASE_RECEIPT_MAX_BYTES } from "./src/io/release/receipt.js";
export { releaseSource, verifyNativeReleaseReceipt, runReleaseGate } from "./src/io/release.js";
export { ReleaseTransportError, unpackReleaseReceipt, GitHubReleaseTransport, readGitHubReleaseReceipt, latestGitHubReleaseRun } from "./src/io/release/transport.js";
export { importStyleViolations } from "./src/io/static/style.js";
export { tapTests, committedTest } from "./src/io/tap.js";
export { testActionKeys, testResultStore, reusableResult, suiteProven, planTestActions, preQueueReuse, reuseReceipt, RECORD_ONLY_PREFIX, TEST_REUSE_RECORD, settleTestActions, recordTestAction, LEDGER_HITS_ENV, TEST_ACTIONS_ENV, TEST_STAGE_ENV } from "./src/io/test/action/cache.js";
export { prepareTestResultExchange } from "./src/io/test/action/transfer.js";
export { testCapacityReport } from "./src/io/test/capacity.js";
export { testConversionPlan } from "./src/logic/test/conversion.js";
export { validatePlacementIndex, readPlacementIndex, readPlacementReport, writePlacementIndex, indexedStageSelection } from "./src/io/test/economics/placement.js";
export { testValueCosts, journeyReason, placeTest, placementReport, testsAtStage, auditInterval, incrementalAudit, mainRedCheckFiles, mainRedFrozenCheck, mainRedFilesProven, TEST_VALUE_DEFAULTS, auditFailureItem } from "./src/io/test/economics.js";
export { dispatchTestFiles, reportDispatchedTests, nativeFileArguments, testFileOptions, optionTakesValue, knownNodeOption, legacyFileMode, legacyNativeFileRun } from "./src/io/test/file/dispatch.js";
export { testFilePool, testFilePoolValue, occupiedPlaces, takeTestFileToken, reserveTestFileToken, awaitNestedRun, awaitNestedPhase, withNestedGroup, longestFirst, TEST_FILE_POOL_ENV, TEST_FILE_CORES_ENV } from "./src/io/test/file/pool.js";
export { isolateTestMachine, foreignNodeOptions, ACCOUNT_HOME_ENV, RUNNER_PRELOAD_ENV } from "./src/io/test/isolation.js";
export { RUNNER_JOB_ENV, TESTS_ON_COORDINATOR, isCoordinatorMachine, coordinatorTestRefusal, refuseTestsOnCoordinator, testProcesses } from "./src/io/coordinator/guard.js";
export { testOutcomeCollector, formatTestOutcomes, readTestOutcomes, allTestOutcomes, committedTestOutcomes, trailer, notify, testOutcomeFields } from "./src/io/test/outcomes.js";
export { refreshTestPlacement } from "./src/io/test/placement/report.js";
export { testWord, paidTests, placementSubmitSelection, valueGateCommand, placementLandingGate, placementLandingPlan, VALUE_GATE } from "./src/io/test/placement.js";
export { testResultDigest, validTestTap, validTestResult, storeTestResult, selectedTestResults, packTestResults, importTestResults, completedTestResult, retainTestResultCompletion, TEST_RESULT_VERSION, TEST_RESULT_STORE_ENV, TEST_RESULT_ORIGIN_ENV, TEST_RESULT_REQUEST_ENV } from "./src/io/test/store.js";
export { runFullSuite, testFiles, runTestFiles, inCleanCheckout, uncommittedNotice } from "./src/io/test/run.js";
export { readTestFileBudgets, testFileBudgetPath } from "./src/io/test/file/policy.js";
export { testSelectionPatterns, narrowsSelection, landingShardOptions, landingFanOutFiles, shardSelectionMatched, SHARD_SELECTED_LINE, selectedTestResult, isGitWorkTree, trackedDefaultTestFiles, shardArguments, hasTestFiles, explicitTestFiles, isDefaultTestFile, default as testSelectionDefault } from "./src/io/test/selection.js";
export { readTestValueTimings, retainTestValueTimings, fileTimesPath, readFileTimes } from "./src/io/test/value/timing.js";
export { testValueReport } from "./src/io/test/value.js";
export { runTimedShell } from "./src/io/timed.js";
export { timingRunner, timingFromOutput, logLines, timingFromLog, runnerPhaseFields, runnerPhaseLine, startRunnerPhases } from "./src/io/timing.js";
export { timingSource, sameTimingSource, suiteTimingFields, formatSuiteTiming, suiteTimingFromOutput, timingAccountingOutput, timingAccountingStages, observedRunTiming, beginSuiteTiming, TIMING_RUN_ID_ENV, SUITE_TIMING_PREFIX } from "./src/io/run/timing.js";
export { failedAssertionLines, retainedGateAssertions, testOutputSummary, retainTestOutput, renderTestSummary, summaryProfile, withTestOutput } from "./src/io/test/summary.js";
export { cachedAffectedGraph } from "./src/io/affected/graph/cache.js";
export { checkCoordinatorRelease, recordCoordinatorRelease, readCoordinatorRelease } from './src/io/coordinator/release.js';
export { TEST_TIERS_FILE, generateTestTiers, formatTestTiers, writeTestTiers } from './src/io/test/tiers.js';

export { reviewCitations, citedReceiptsNote, citedReceipts, landingRunFiles } from './src/io/once.js';
export { redGateScope, redGateReport, runnerErrors } from './src/io/red.js';
export { requireTestTierAccount, requireSealedSkips, hasTestTiers, generateTestTiersAt, selectTestTiers, testTierProofFiles, testTierCommand, testTierCheckCommand, testTierReport } from './src/io/test/tier/selection.js';
export { testRunPhaseClock } from './src/io/test/run/phases.js';

export { testTimeBudget, testTimeBudgetLines } from './src/logic/test/budget/time.js';

export { runGateStages } from "./src/logic/stages.js";
export { GATE_PROGRESS_MS, withGateProgress, reportGateProgress, progressingWait, whileGateRuns } from "./src/io/progress.js";
export { packageHashesAt, unsealedPackages, sealStoreFile, recordSeal, sealOf, sealStatus, checkSkippedSeals } from './src/io/seals.js';

export { privateCheckAdmission } from './src/io/admission/private/check.js';
export {
  DEFAULT_TEST_FILE_TIMEOUT_MS,
  TEST_CHILD_CLEANUP_FAILED,
  testFileTimeoutMs,
  activeHandleSummary,
  installTestChildDrain,
} from './src/io/test/drain.js';
export { gateMachineHome, gateRuntimeCaptureSource } from './src/logic/preload.js';
export { changedStaticFailures, stagedHookFailures } from './src/io/changed/static.js';
export { STATIC_CHECKS, runStaticRegistry } from './src/io/static/check/registry.js';
export { STATIC_SCOPE_ENV, analysisChange, analysisKey, analysisScope, readAnalysisMemo, staticScopeFromEnv, writeAnalysisMemo } from './src/io/static/scope.js';
export { fixedWallMargins, wallClockViolations } from './src/io/budgets.js';
export { LOAD_BEARING_CEILINGS, LOAD_BEARING_CELLS, loadBearingJudged, loadBearingSites, loadBearingCounts, loadBearingGrowth, loadBearingRaised, loadBearingFailures } from "./src/logic/load/bearing.js";
export { freeRunnerSlots } from "./src/io/shards/proof.js";
export { keepClaimsAlive } from "./src/io/keepalive.js";
export { beatSeat } from "./src/io/keepalive.js";
export { gateHealthLines } from "./src/logic/health.js";
export { gateHealthReport } from "./src/io/health.js";
export { maintainPartsStore, prunePartsStore } from './src/io/test/action/prune.js';
export { firstChangedInput, recordInputParts, ledgerFromOutput, phaseLedger } from './src/io/test/account.js';
export { FILE_TIME_LINE, LANDING_COLLECT_ALL_ENV, LANDING_FILE_TIMES_ENV, LANDING_SHARD_ENV, fileKey, landingBalance, landingFloor, planFreeSlotShards, planLandingShards, planReleaseShards, printShardFileTimes, releasePlacement, runTestShards, runnerFailureClass, shardFileTimes, watchdogStoppedOnly } from "./src/io/test/shards.js";
export { lex } from './src/io/scan.js';
export { report } from './src/io/scan.js';
export { walk } from './src/io/scan.js';
export { acceptedCellsIdentity, toolingIsPinned, readAcceptedCells, warmAcceptedCells, nudgeAcceptedCells, recordAcceptedCellsFailure, waitForAcceptedCells } from './src/io/inventory.js';
