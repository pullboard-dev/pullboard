import { prepareFlakeLanding } from './publish.js';
import { checkFlakeRatchet } from './publish.js';
import { hasTestTiers } from '../../../../gate/heavy.js';
/** Coordinator landing trunk step; source-preserving partition of land.js [B3,R3,C7]. */
import { runDeferredGuards } from '../deferred/run.js';
import * as store from '../../../../store/index.js';
import { smokeCandidate } from '../smoke.js';
import { submitHandoff } from '../../../../store/index.js';
import { Refused } from '../../../../kernel/index.js';
import { landingFailures } from './failures.js';
import { save } from './merge.js';
import { returnCulprits } from './diagnose.js';
import { deferredSelections } from './gate.js';
import { refusalRecord } from '../../logic/hold.js';

/**
 * The proof a landing records: a green gate's tree and log, keeping the submit receipt it reused, or the waived
 * proof for a red one [C7,#2902]. Why: the board must be able to name the receipt that proved a reused tree.
 */
export function landingProof(gate, waived) {
  if (!gate.isGreen) return waived();
  return { tree: gate.tree, failures: [], logPath: gate.logPath, ...(gate.reusedSubmitGate ? { reusedSubmitGate: gate.reusedSubmitGate } : {}) };
}

/**
 * A green submit gate that already ran exactly this merged tree, for the batch's one item at its frozen bar, or null
 * [C7,#2902]. Why: when main has not moved since the item's gate, landing re-ran the same tests on the same bytes.
 */
export function provenTreeGate(board, items, tree, { external = false } = {}) {
  // A coordinator's named landing names commits it proved elsewhere: every item of the batch rides on that proof, and
  // only the static checks and the CLI smoke run on the merged tree, on the runners [C7,#5559].
  if (external && tree) return { isGreen: true, tree, failures: [], logPath: null, externalProof: items.map(entry => entry.id) };
  if (items.length !== 1 || !tree) return null;
  const item = store.getItem(board, items[0].id);
  const job = submitHandoff(board, items[0].id);
  if (!item || !job || job.state !== 'green' || job.gateGreen === false || job.executionTree !== tree
    || job.commit !== items[0].commit || job.digest !== item.item_frozen_digest) return null;
  // A submit that deferred affected files to landing never ran them, so its green proves only part of this tree.
  const state = { board, batch: { items } };
  if (deferredSelections(state).length) return null;
  return { isGreen: true, tree, failures: [], logPath: null, reusedSubmitGate: job.id };
}

/**
 * The CLI smoke a landing's guards run: the caller's stand-in, else smokeCandidate, which runs on a runner when
 * gate.runnersOnly is on and never as a local process. Why: the proven-tree path called the local smoke directly, so
 * a landing that reused its submit gate still ran a CLI smoke on the coordinator (#3011).
 *
 * @param {{ runLandingCliSmoke?: Function }} services
 * @returns {Function}
 */
export function landingSmoke(services) {
  return services.runLandingCliSmoke ?? smokeCandidate;
}

/**
 * Run every affected test file a submit deferred over submitDeferAbove on the merged tree, before anything lands.
 * A red sends back each item whose own deferred selection holds a failing file, the way a red submit would.
 */
async function deferredGuards(state) {
  if (hasTestTiers(state.batch.root)) return; // The batch gate and its bisection own journey failures.
  return runDeferredGuards(state, { deferredSelections, landingFailures, save, returnCulprits });
}

/** Run the deferred affected tests before an inline landing's gate; false when they are red and nothing may land. */
export async function inlineDeferredGuards(state) {
  try { await deferredGuards(state); return true; } catch (error) {
    if (!(error instanceof Refused) || error.code !== 'GATE_RED') throw error;
    state.say(`nothing landed: ${error.message}`);
    return false;
  }
}

/**
 * Bind the flake ratchet to the batch, or record its refusal as a blocked batch; true when the landing may go on.
 * Why: an unrecorded ratchet refusal ended the worker with the batch still gating, so each restart adopted it and ran
 * its gate again (5 Nov: one item gated three times in 20 minutes behind one unquarantined flake) [C7].
 */
export async function flakeRatchetOrBlock(state) {
  try {
    await prepareFlakeLanding(state);
    return true;
  } catch (error) {
    if (error?.code !== 'FLAKE_RATCHET') throw error;
    await save(state, { state: 'blocked', failures: [{ file: null, name: error.message }], ...refusalRecord(state.batch, error, state.board.clock.now().toISOString()) });
    state.say(`nothing landed: ${error.message}`);
    return false;
  }
}

/**
 * Ask the flake ratchet before the batch merges or gates. A refusal records the batch blocked FLAKE_RATCHET, starts no
 * gate run and is thrown so the landing exits as refused. The publish step still checks again for a flake proven during
 * the gate. Why: a batch the ratchet would refuse spent a whole gate first [C7].
 */
export async function flakeRatchetBeforeGate(state) {
  try { checkFlakeRatchet(state); } catch (error) {
    if (error?.code === 'FLAKE_RATCHET') await save(state, { state: 'blocked', failures: [{ file: null, name: error.message }], ...refusalRecord(state.batch, error, state.board.clock.now().toISOString()) });
    throw error;
  }
}
