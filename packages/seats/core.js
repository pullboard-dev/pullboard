/** Process-free lane policy for native move descriptors; no shell module is loaded [C7]. */
export {
  laneLeads,
  routeLaneMessage,
  leadOwnsDecision,
  isLaneEscalation,
  laneAnswerFloor,
  laneMessageFloor,
} from './src/core/lane-lead.js';
export {
  flowWindowBounds,
} from './src/core/flow-window-bounds.js';
export {
  parseDependency,
  validateNativeDependencies,
  dependencyReferences,
  localDependencyIds,
} from './src/core/dependency-references.js';
