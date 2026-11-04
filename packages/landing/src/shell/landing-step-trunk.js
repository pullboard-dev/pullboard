import { prepareFlakeLanding } from './landing-step-publish.js';
import { hasTestTiers } from '../../../gate/index.js';
/** Coordinator landing trunk step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from './landing-completion.js';
import { runnerExecutionServices } from '../../../runners/index.js';
import { landingExecutionServices } from './landing-shards.js';
import { runDeferredGuards } from './landing-deferred-run.js';
import { requireLocalGuardClassification } from '../core/land-local-guard.js';
import { requireOutsideOwner } from '../../../items/index.js';
import * as store from '../../../../src/board.js';
import { headCommit } from '../../../../src/git.js';
import { headTree } from '../../../git/index.js';
import { runLandingCliSmoke } from './landing-cli-smoke.js';
import { submitHandoff } from '../../../store/index.js';
import { mainCheckout } from '../../../../src/git.js';
import { runStaticChecks } from '../../../gate/index.js';
import { Refused } from '../../../kernel/index.js';
import { gateGroup } from './landing-step-gate.js';
import { waivedProof } from './landing-step-failures.js';
import { unwaivedFailures } from './landing-step-failures.js';
import { bisectableFailures } from './landing-step-failures.js';
import { landingFailures } from './landing-step-failures.js';
import { save } from './landing-step-merge.js';
import { returnCulprits } from './landing-step-diagnose.js';
import { deferredSelections } from './landing-step-gate.js';
import { mergeGroup } from './landing-step-merge.js';
import { diagnose } from './landing-step-diagnose.js';
import { bisect } from './landing-step-diagnose.js';
import { fileFlakes } from './landing-step-diagnose.js';
import { fileTestDefects } from './landing-step-diagnose.js';
import { finishTrunk } from './landing-step-publish.js';
import { refusalRecord } from '../core/runner-source-hold.js';

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
export function provenTreeGate(board, items, tree) {
  if (items.length !== 1 || !tree) return null;
  const item = store.getItem(board, items[0].id);
  const job = submitHandoff(board, items[0].id);
  if (!item || !job || job.state !== 'green' || job.gateGreen === false || job.executionTree !== tree
    || job.commit !== items[0].commit || job.digest !== item.item_frozen_digest) return null;
  return { isGreen: true, tree, failures: [], logPath: null, reusedSubmitGate: job.id };
}

/**
 * Prove a tier-1 batch's actual merged diff with submit's affected map (#1277). Fixed invariants and registry
 * guards remain a floor; an uncertain import graph requires the configured full gate before adoption.
 */
async function quickGuards(state, label = 'local-trunk') {
  const proven = provenTreeGate(state.board, state.batch.items, headTree(state.batch.root));
  if (proven) {
    await runStaticChecks(state.batch.root, state.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, agent: 'coordinator', onWait: state.onWait });
    runLandingCliSmoke(state.batch.root);
    state.say?.(`#${state.batch.items[0].id}: its submit gate ${proven.reusedSubmitGate} already proved this exact tree green; no tests rerun`);
    return proven;
  }
  await runStaticChecks(state.batch.root, state.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, agent: 'coordinator', onWait: state.onWait });
  const gate = await gateGroup(state, label, { localTrunk: true });
  if (!gate.isGreen && !waivedProof(state, gate) && (!completeGate(gate, { allowCancelled: Boolean(gate.knownMain?.length) }) || !gate.accounted)) {
    // Named reds no waiver covers are enough to bisect: the board finds the culprits instead of stopping [C7,#2900].
    const own = bisectableFailures(state.board, gate.failures, state.landingPorts);
    if (!own) throw new Refused('LAND_DIAGNOSTIC', 'the local-trunk guards have no complete accounted failure; inspect the recorded gate before adopting');
    return { ...gate, failures: own, unaccounted: true };
  }
  if (!gate.isGreen && !waivedProof(state, gate)) requireLocalGuardClassification(state, gate);
  return gate;
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
 * Tier 1 (#801): after a clean merge and its quick guards, the batch lands on the local trunk in seconds, with each
 * item's merged receipt; nothing is pushed. pullboard publish runs the whole suite on the trunk head and pushes it.
 */
export async function landOnTrunk(state) {
  await save(state, { state: 'gating', tip: headCommit(state.batch.root) });
  let gate;
  try {
    gate = await quickGuards(state);
    if (!gate.isGreen && !waivedProof(state, gate)) {
      const own = unwaivedFailures(state.board, gate.failures, state.landingPorts);
      const flakyFiles = await diagnose(state, own, gate);
      if (flakyFiles.length) { await fileFlakes(state, gate, flakyFiles); state.flaky = true; return; }
      const green = await bisect(state, state.batch.items, own, 'local-split', quickGuards);
      if (state.flaky || !green.length) {
        if (!state.flaky) await save(state, { state: 'blocked', culprits: state.culprits });
        return;
      }
      const rebuilt = await mergeGroup(state, green);
      await save(state, { ...rebuilt, culprits: state.culprits });
      gate = await quickGuards(state, 'local-green-items');
      if (!gate.isGreen && !waivedProof(state, gate)) {
        if (!state.culprits.length) { await fileTestDefects(state, gate); state.flaky = true; return; }
        await save(state, { state: 'blocked', failures: gate.failures, culprits: state.culprits });
        throw new Refused('LAND_INTERACTION', 'the individually green items fail together; nothing retries or lands; inspect the batch’s failing tests');
      }
    }
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    // The refusal is kept with its code so a RUNNER_SOURCE count across these blocked batches can hold the items [C7].
    if (!['flaky', 'test-defect'].includes(state.batch.state)) await save(state, { state: 'blocked', failures: [{ file: null, name: error.message }], ...refusalRecord(state.batch, error, state.board.clock.now().toISOString()) });
    state.say(`nothing landed: ${error.message}`);
    return;
  }
  for (const entry of state.batch.items) {
    const item = store.getItem(state.board, entry.id);
    requireOutsideOwner(state.board, item);
    if (item.item_status !== 'verified' || item.item_commit !== entry.commit) throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} changed after the batch merged; rebuild its landing`);
  }
  if (mainCheckout(state.root)?.commit !== state.batch.base) throw new Refused('LAND_TRUNK_MOVED', 'main moved during the landing; rebuild the batch from its new tip');
  const proof = landingProof(gate, () => waivedProof(state, gate));
  if (!proof) throw new Refused('LAND_WAIVER', 'the local-trunk red lost its live person waiver; ask the person for a new expiring waiver, then adopt the batch');
  await prepareFlakeLanding(state);
  await save(state, { state: 'trunk', proof });
  await finishTrunk(state);
}
