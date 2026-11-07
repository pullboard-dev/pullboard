/** drive front door: continue a durable job from its last written step, and the dispatcher row that keeps one driver loop alive [C7]. */
export { driveOnce } from './src/shell/drive-once.js';
export { PHASES, phaseOf, owedShards, shardSections } from './src/core/drive-phase.js';
export { ensureDispatcher, renewDispatcher, DISPATCHER_JOB } from './src/shell/dispatcher.js';
export { reclaimPass, lapsedGateJobs, FALLBACK_BUDGET_MS } from './src/shell/fallback-reclaim.js';
