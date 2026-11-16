/** @pullboard-module-loads packages/moves/src/io/freezer.js packages/moves/src/logic/table/lease.table.js packages/moves/src/logic/table/run.js packages/moves/src/logic/table/submit.table.js packages/moves/src/logic/table/withdraw.table.js packages/moves/src/logic/table/claim.table.js packages/moves/src/logic/table/release.table.js packages/moves/src/logic/table/job.table.js packages/moves/src/logic/table/reopen.table.js packages/moves/src/io/selection.js packages/moves/src/logic/reasons.js */
/** The move registry's next steps, the claim criterion freezer and the move tables, without the selection and the rest the cell index also loads [C7]. */
import { createRequire } from 'node:module';
import { withMoveNextSteps as withRegistrySteps } from './src/io/registry.js';
export { MOVE_REGISTRY, MOVE_OPERATIONS, minimumMoveEngine, declaredMoveActor } from './src/io/registry.js';

/**
 * Add the moves' own next steps to the default guidance.
 *
 * @param {Readonly<Record<string, string>>} defaults
 * @returns {Readonly<Record<string, string>>}
 */
export function withMoveNextSteps(defaults) { return withRegistrySteps(defaults); }

const requireModule = createRequire(import.meta.url);

/**
 * The claim move's criterion freezer, whose doctrine, gate and verify loads come at its first call.
 * Why: the registry and next-step readers of this door never freeze a criterion, so they never pay for its ~25 modules [C7,#7081].
 *
 * @param {...any} args - As the freezer module's criterionFreezer.
 * @returns {(item: any) => { text: string, digest: string }}
 */
export function criterionFreezer(...args) { return requireModule('./src/io/freezer.js').criterionFreezer(...args); }

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
/** The release move table's engine, for the store's release writer to run [C7,#8246]. */
export const releaseEngine = tableOnDemand('./src/logic/table/release.table.js', 'releaseEngine');
/** The gate-job queue table's engine, for the api job writer's shadow compare [C7,#8310]. */
export const jobEngine = tableOnDemand('./src/logic/table/job.table.js', 'jobEngine');
/** The reopen move table's engine, for the store's reopen writer's shadow compare [C7,#8388]. */
export const reopenEngine = tableOnDemand('./src/logic/table/reopen.table.js', 'reopenEngine');

/** Next's selection and its wait reasons, loaded at next's first call: claim and the registry readers of this door never select [C7,#7081]. */
const selection = () => requireModule('./src/io/selection.js');
const reasons = () => requireModule('./src/logic/reasons.js');
/** @param {...any} args - As selection.js nextOnce. @returns {any} */
export function nextOnce(...args) { return selection().nextOnce(...args); }
/** @param {...any} args - As reasons.js answerFirstReasons. @returns {any} */
export function answerFirstReasons(...args) { return reasons().answerFirstReasons(...args); }
/** @param {...any} args - As reasons.js foldedReasons. @returns {any} */
export function foldedReasons(...args) { return reasons().foldedReasons(...args); }
/** @param {...any} args - As reasons.js heldCounted. @returns {any} */
export function heldCounted(...args) { return reasons().heldCounted(...args); }
/** @param {...any} args - As reasons.js inboxReasons. @returns {any} */
export function inboxReasons(...args) { return reasons().inboxReasons(...args); }
/** @param {...any} args - As reasons.js ownWaitingLines. @returns {any} */
export function ownWaitingLines(...args) { return reasons().ownWaitingLines(...args); }
