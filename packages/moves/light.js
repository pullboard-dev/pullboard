/** The move registry's next steps and the claim criterion freezer, without the selection and the rest the cell index also loads [C7]. */
import { withMoveNextSteps as withRegistrySteps } from './src/io/registry.js';
export { MOVE_REGISTRY, MOVE_OPERATIONS, minimumMoveEngine, declaredMoveActor } from './src/io/registry.js';
export { criterionFreezer } from './src/io/freezer.js';

/**
 * Add the moves' own next steps to the default guidance.
 *
 * @param {Readonly<Record<string, string>>} defaults
 * @returns {Readonly<Record<string, string>>}
 */
export function withMoveNextSteps(defaults) { return withRegistrySteps(defaults); }
