/** The move registry's next steps, without the freezer and selection that the cell index also loads [C7]. */
import { withMoveNextSteps as withRegistrySteps } from './src/io/registry.js';
export { MOVE_REGISTRY, MOVE_OPERATIONS, minimumMoveEngine, declaredMoveActor } from './src/io/registry.js';

/**
 * Add the moves' own next steps to the default guidance.
 *
 * @param {Readonly<Record<string, string>>} defaults
 * @returns {Readonly<Record<string, string>>}
 */
export function withMoveNextSteps(defaults) { return withRegistrySteps(defaults); }
/** The landing lease table's engine, for the store cell's lease rules to read [C7,#8164]. */
export { LEASE_MOVES, leaseEngine } from './src/logic/table/lease.table.js';
export { runTable } from './src/logic/table/run.js';
/** The claim and renew move table's engine, for the store's claim writer to run [C7,#8270]. */
export { claimEngine } from './src/logic/table/claim.table.js';
