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
export {
  laneOf,
} from './src/core/lane-of.js';
export {
  computerLabel,
  coordinatorHolder,
} from './src/core/coordinator-holder.js';
export {
  displayAgentName,
} from './src/core/agent-names.js';
export {
  ROUTES,
  canTake,
  cappedRoute,
} from './src/core/route-escalation.js';
export {
  takeoverReady,
} from './src/core/line-capacity.js';
export {
  ACTIVE_REVIEWER_WINDOW_MINUTES,
  lineWipLimit,
} from './src/core/line-wip-limit.js';
