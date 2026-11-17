/** @pullboard-module-loads packages/moves/src/logic/table/lease.table.js packages/moves/src/logic/table/run.js packages/moves/src/logic/table/submit.table.js packages/moves/src/logic/table/withdraw.table.js packages/moves/src/logic/table/claim.table.js packages/moves/src/logic/table/release.table.js packages/moves/src/logic/table/job.table.js packages/moves/src/logic/table/reopen.table.js packages/moves/src/logic/table/pulled.table.js */
/** The move registry's next steps and the move tables, without the freezer, selection and the rest the cell index also loads [C7]. */
import { createRequire } from 'node:module';
import { withMoveNextSteps as withRegistrySteps } from './src/io/registry.js';
export { MOVE_REGISTRY, MOVE_OPERATIONS, minimumMoveEngine, declaredMoveActor } from './src/io/registry.js';
/** The claim-head refusal, so a claim need not load the cell index's freezer and selection modules [C7,#9895]. */
export { offMainHeadRefusal } from './src/io/claim-head.js';

/**
 * Add the moves' own next steps to the default guidance.
 *
 * @param {Readonly<Record<string, string>>} defaults
 * @returns {Readonly<Record<string, string>>}
 */
export function withMoveNextSteps(defaults) { return withRegistrySteps(defaults); }

const requireModule = createRequire(import.meta.url);


/**
 * One move table's engine, whose module loads at its first call and is kept for the process.
 * Why: the board root hands every table to the store at open, and a read or a claim must not pay for the tables it never runs [C7,#7081].
 *
 * @param {string} file - The table module, relative to this file.
 * @param {string} name - Its engine export.
 * @returns {(...args: any[]) => any}
 */
function tableOnDemand(file, name) {
  let loaded = null;
  return { [name](...args) { return (loaded ??= requireModule(file)[name])(...args); } }[name];
}

/** The landing lease table's engine, for the store cell's lease rules to read [C7,#8164]. */
export const leaseEngine = tableOnDemand('./src/logic/table/lease.table.js', 'leaseEngine');
/** The one pure engine every move table runs through [C7,#8064]. */
export const runTable = tableOnDemand('./src/logic/table/run.js', 'runTable');
/** The submit family's tables, for the store's submit writers to run [C7,#8271]. */
export const submitEngine = tableOnDemand('./src/logic/table/submit.table.js', 'submitEngine');
/** The withdraw move table's engine, for the store's withdraw writer to run [C7,#8273]. */
export const withdrawEngine = tableOnDemand('./src/logic/table/withdraw.table.js', 'withdrawEngine');
/** The claim and renew move table's engine, for the store's claim writer to run [C7,#8270]. */
export const claimEngine = tableOnDemand('./src/logic/table/claim.table.js', 'claimEngine');
/** The verify move table's engine, for the store's verify writer to run [C7,#8272]. */
export const verifyEngine = tableOnDemand('./src/logic/table/verify.table.js', 'verifyEngine');
/** The landing tables' engine, for the store's merged writer to run [C7,#8268]. */
export const landingEngine = tableOnDemand('./src/logic/table/landing.table.js', 'landingEngine');
/** The release move table's engine, for the store's release writer to run [C7,#8246]. */
export const releaseEngine = tableOnDemand('./src/logic/table/release.table.js', 'releaseEngine');
/** The gate-job queue table's engine, for the api job writer's shadow compare [C7,#8310]. */
export const jobEngine = tableOnDemand('./src/logic/table/job.table.js', 'jobEngine');
/** The reopen move table's engine, for the store's reopen writer's shadow compare [C7,#8388]. */
export const reopenEngine = tableOnDemand('./src/logic/table/reopen.table.js', 'reopenEngine');
/** The reclaim table's engine, for the store's stale-state maintenance shadow compare [C7,#9367]. */
export const reclaimEngine = tableOnDemand('./src/logic/table/reclaim.table.js', 'reclaimEngine');
/** The landing-pulled table's engine, for the store's pulled writer to run [M2,R3,#9098]. */
export const pulledEngine = tableOnDemand('./src/logic/table/pulled.table.js', 'pulledEngine');

