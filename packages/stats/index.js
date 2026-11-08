export { carryingCapacity } from './src/core/carrying-capacity.js';
export { readCarryingCapacity } from './src/shell/carrying-capacity-read.js';
/** Canonical named entry points for the planned cell; implementations retain their current owner [C7]. */
export { workFreeReleases, readWorkFreeReleases } from './src/core/work-free-releases.js';
export { buildTimeStats, buildTimeLines } from './src/core/stats-build-time.js';
export {
  nativeToolCallIds,
  nativeLastPrompt,
} from './src/core/exit-rules-calls.js';
export {
  repeatedExitFailure,
  exitRulesDecision,
  contextCeiling,
  exitContextDecision,
} from './src/core/exit-rules-policy.js';
export {
  replayHistory,
  observedCapacity,
  replayObservations,
} from './src/core/flow-replay-history.js';
export {
  replayFlow,
} from './src/core/flow-replay.js';
export {
  emptyReportCounter,
  appendReportCounter,
} from './src/core/flow-report-counter.js';
export {
  FLOW_REPORT_VERSION,
  reportEvent,
  safeReportPolicy,
  newReportPolicy,
  frozenReport,
  advanceReport,
  projectReportWindows,
  prepareReportMove,
  recordReport,
  affectedReportItems,
  indexReportItem,
  recordReportPolicy,
  projectReport,
} from './src/core/stats-flow-report.js';
export {
  WINDOW_STAGES,
  newWindowTrace,
  observeFlowStage,
  observeFlowVerdict,
  observeFlowGap,
  frozenWindowTrace,
  flowWindowMinutes,
  projectFlowWindow,
  flowWindowLines,
  comparisonBounds,
  projectWindowComparison,
  comparisonLines,
  flowWindowBounds,
} from './src/core/stats-flow-window.js';
export {
  roleOf,
  moveFlowItem,
  prepareFlowHistory,
  compareFlowWindows,
  projectFlowStats,
  flowStats,
  flowLines,
  flowReportLines,
  flowAlertLine,
} from './src/core/stats-flow.js';
export {
  sinceDate,
  eventCounts,
  proofStats,
} from './src/shell/stats.js';
export {
  CAPACITY_VERSION,
  emptyCapacityCounter,
  appendCapacityCounter,
} from './src/core/capacity-counter.js';
export {
  fitCapacity,
  planCapacity,
  capacityLines,
} from './src/core/capacity-model.js';
export {
  capacityAtRead,
  readCapacity,
} from './src/shell/capacity-read.js';
export {
  refreshCapacity,
} from './src/core/capacity-store.js';
export {
  publishUsage,
  checkpointAfterMove,
} from './src/shell/cost-checkpoint.js';
export {
  USAGE_CHECKPOINT_ENV,
  drainUsageCheckpoints,
  usageDueDirectory,
} from './src/shell/cost-due.js';
export {
  usageCheckpoint,
} from './src/shell/cost-ledger.js';
export {
  nativeUsage,
} from './src/shell/cost-provider.js';
export {
  USAGE_BATCH_LIMIT,
  UNKNOWN_USAGE_REASONS,
  SPLIT_COUNTS,
  COUNTS,
  sumUsage,
  itemCost,
  publicUsage,
  unknownInputSplit,
  hasInputSplit,
} from './src/shell/cost-read.js';
export {
  sessionSource,
  sessionSnapshot,
  usageDifference,
} from './src/shell/cost-session.js';
export {
  sharedBefore,
  sharedAfter,
} from './src/shell/cost-shared-ledger.js';
export {
  sharedSessionTotals,
  recordSharedUsage,
  publicSharedSessions,
} from './src/shell/cost-shared.js';
export {
  sanitizedUsage,
  recordUsage,
  costTotals,
  storedSeatUsage,
} from './src/shell/cost.js';
export {
  recordUsageBatch,
} from './src/shell/cost-usage-batch.js';
export {
  pipelineLimit,
  pipelineStats,
  pipelineLines,
  pipelinePerHour,
  pipelinePerHourLines,
} from './src/core/stats-pipeline.js';
export {
  moveTranscripts,
  movesStats,
  movesLines,
} from './src/core/stats-moves.js';
export {
  wilson,
  costAnalytics,
} from './src/shell/cost-analytics.js';
export {
  TIME_PHASES,
  timeWindowDays,
  timeStats,
  timeLines,
  checkpointLine,
  weeklyDue,
} from './src/core/stats-time.js';
export {
  readTimeHistory,
  appendTimeCheckpoint,
} from './src/shell/time-history.js';

export { coordinatorActionStats, coordinatorActionLines, coordinatorActionRise } from './src/core/coordinator-actions.js';
export { coordinatorActions, coordinatorMilestoneRelease, previousCoordinatorMilestone } from './src/shell/coordinator-actions.js';

export { recordTimeCheckpoint } from './src/shell/stats-time-checkpoint.js';
export { buildCalibration } from './src/core/build-calibration.js';
export { isProofAgent, proofAgentIds } from './src/shell/stats.js';

export { idleSkipMinutes } from './src/core/idle-skip-minutes.js';
