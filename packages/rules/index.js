/** Lifecycle rules over recorded facts, and a read-only trial that replays a board's event log through them [C7]. */
export { RULES_VERSION, STATES, MOVE_RULES, GUARDS, newItem, leaseLive, unmetWaits, readiness, ruleOf, judge, apply } from './src/logic/lifecycle.js';
export { lifecycleFact, replay, compareFinal, readinessCounts, topKinds, trial } from './src/logic/replay.js';
export { LIFECYCLE_KINDS, readLifecycleLog } from './src/io/read.js';
