/** @pullboard-module-loads packages/store/index.js */
/** The store calls the offer and queue path makes, loaded from the store barrel on the first call: an add that never queues a job does not load it, and the api light door stays under its cold budget [C7]. */
import { createRequire } from 'node:module';

const requireModule = createRequire(import.meta.url);
let store = null;
const loaded = () => (store ??= requireModule('../../../store/index.js'));

/** The runs file holder of an open board. */
export function boardRunsHolder(...args) { return loaded().boardRunsHolder(...args); }
/** The runs port over an open runs file. */
export function runsPort(...args) { return loaded().runsPort(...args); }
/** Queue one job: intent, run row, then the offer. */
export function queueRun(...args) { return loaded().queueRun(...args); }
/** The ledger hits a shard carries. */
export function ledgerHits(...args) { return loaded().ledgerHits(...args); }
/** Why each file of a shard without a hit has none: none, red or changed. */
export function ledgerMissReasons(...args) { return loaded().ledgerMissReasons(...args); }
/** Record one shadow comparison. */
export function recordShadow(...args) { return loaded().recordShadow(...args); }
/** The first difference between a decided and a written job. */
export function firstDifference(...args) { return loaded().firstDifference(...args); }
/** Make sure the gate hop table exists. */
export function ensureGateHopTable(...args) { return loaded().ensureGateHopTable(...args); }
/** One item's gate hop row. */
export function readGateHop(...args) { return loaded().readGateHop(...args); }
/** The items still expedited: an expedite event and no gate verdict after it. */
export function expeditedItems(...args) { return loaded().expeditedItems(...args); }
/** Move one item's gate hop. */
export function gateHopMove(...args) { return loaded().gateHopMove(...args); }
