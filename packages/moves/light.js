/** The move registry's next steps, without the freezer and selection that the cell index also loads [C7]. */
import { withMoveNextSteps as withRegistrySteps } from './src/io/registry.js';

/**
 * Add the moves' own next steps to the default guidance.
 *
 * @param {Readonly<Record<string, string>>} defaults
 * @returns {Readonly<Record<string, string>>}
 */
export function withMoveNextSteps(defaults) { return withRegistrySteps(defaults); }
