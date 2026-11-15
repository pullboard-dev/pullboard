/** Browser-safe pure lane policy for native move descriptors: no node: built-in, no shell [C7,D3]. */
export {
  laneLeads,
  routeLaneMessage,
  leadOwnsDecision,
  isLaneEscalation,
  laneAnswerFloor,
  laneMessageFloor,
} from './src/logic/lane/lead.js';
export {
  flowWindowBounds,
} from './src/logic/bounds.js';
export {
  parseDependency,
  validateNativeDependencies,
  dependencyReferences,
  localDependencyIds,
} from './src/logic/references.js';
export {
  laneOf,
} from './src/logic/lane/lookup.js';
export {
  computerLabel,
  coordinatorHolder,
} from './src/logic/holder.js';
export {
  displayAgentName,
} from './src/logic/agent/names.js';
export {
  ROUTES,
  canTake,
  cappedRoute,
} from './src/logic/route/escalation.js';
export {
  takeoverReady,
  seatSessionGone,
  SEAT_SESSION_STALE_MS,
} from './src/logic/line/capacity.js';
export {
  ACTIVE_REVIEWER_WINDOW_MINUTES,
  lineWipLimit,
} from './src/logic/line/limit.js';
