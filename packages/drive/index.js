/** drive front door: continue a durable job from its last written step, and the dispatcher row that keeps one driver loop alive [C7]. */
export { driveOnce } from './src/shell/drive-once.js';
export { PHASES, phaseOf, owedShards, shardSections } from './src/core/drive-phase.js';
export { ensureDispatcher, renewDispatcher, DISPATCHER_JOB } from './src/shell/dispatcher.js';
export { queueFlakeDiagnoses, startFlakeDiagnose, finishFlakeDiagnose, driveFlakeDiagnose, jobbedFlakeObserver, flakeDiagnosesFor } from './src/shell/flake-diagnose.js';
export { FLAKE_DIAGNOSE_KIND, flakeDiagnoseKey, diagnoseTargets } from './src/core/flake-diagnose.js';
