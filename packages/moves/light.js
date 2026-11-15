/** The move registry's next steps, without the freezer and selection that the cell index also loads [C7]. */
import { withMoveNextSteps as withRegistrySteps } from './src/io/registry.js';
/** The submit family's tables, for the store's submit writers to run [C7,#8271]. */
export { submitEngine } from './src/logic/table/submit.table.js';
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
/** The withdraw move table's engine, for the store's withdraw writer to run [C7,#8273]. */
export { withdrawEngine } from './src/logic/table/withdraw.table.js';
/** The claim and renew move table's engine, for the store's claim writer to run [C7,#8270]. */
export { claimEngine } from './src/logic/table/claim.table.js';
/** The release move table's engine, for the store's release writer to run [C7,#8246]. */
export { releaseEngine } from './src/logic/table/release.table.js';
/** The gate-job queue table's engine, for the api job writer's shadow compare [C7,#8310]. */
export { jobEngine } from './src/logic/table/job.table.js';
