export * from './core.js';
export { mainMovedWarnings, warnMainMoved } from './src/shell/main-moved-warning.js';
export { MECHANICAL_VERSION, formatJson, mechanicalConflictFiles, resolveMechanicalIndex } from './src/shell/mechanical-merge.js';
export { mergeMechanicalSources, resolveMechanicalMerge } from './src/shell/train-mechanical-merge.js';
export { trunkMerge, recordedTrunkMerge, refuseRecordedHistoryOverrides } from './src/shell/trunk-merge.js';
export { preparedSourceComposition, sourceConflictFiles, withSourceComposition } from './src/shell/source-advance-compose.js';
