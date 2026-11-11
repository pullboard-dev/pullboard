import { prepareFlakeLanding } from './publish.js';
import { checkFlakeRatchet } from './publish.js';
import { hasTestTiers } from '../../../../gate/index.js';
import { selectAffectedTests } from '../../../../gate/index.js';
/** Coordinator landing trunk step; source-preserving partition of land.js [B3,R3,C7]. */
import { completeGate } from '../completion.js';
import { runnerExecutionServices } from '../../../../runners/index.js';
import { landingExecutionServices } from '../shards.js';
import { runDeferredGuards } from '../deferred/run.js';
import { requireLocalGuardClassification } from '../../logic/land/guard.js';
import { requireNoLockOnlyRed } from '../../logic/land/guard.js';
import { requireOutsideOwner } from '../../../../items/index.js';
import * as store from '../../../../store/index.js';
import { headCommit } from '../../../../git/index.js';
import { git } from '../../../../git/index.js';
import { headTree } from '../../../../git/index.js';
import { smokeCandidate } from '../smoke.js';
import { submitHandoff } from '../../../../store/index.js';
import { mainCheckout } from '../../../../git/index.js';
import { runStaticChecks } from '../../../../gate/index.js';
import { landingStaticRefusal } from '../static.js';
import { Refused } from '../../../../kernel/index.js';
import { gateGroup } from './gate.js';
import { waivedProof } from './failures.js';
import { watchdogProof } from './failures.js';
import { unwaivedFailures } from './failures.js';
import { bisectableFailures } from './failures.js';
import { landingFailures } from './failures.js';
import { save } from './merge.js';
import { splitRedBatch } from './split.js';
import { returnCulprits } from './diagnose.js';
import { deferredSelections } from './gate.js';
import { trunkMoveReruns } from './gate.js';
import { mergeGroup } from './merge.js';
import { diagnose } from './diagnose.js';
import { bisect } from './diagnose.js';
import { splitBaseRed } from './diagnose.js';
import { fileFlakes } from './diagnose.js';
import { fileTestDefects } from './diagnose.js';
import { finishTrunk } from './publish.js';
import { refusalRecord } from '../../logic/hold.js';
import { singleItemLanding } from './selection.js';
import { oneItemBatch } from './selection.js';
import { returnCulprit } from './diagnose.js';
import { namedFailures } from './diagnose.js';
import { returnRefusedItem } from './diagnose.js';
import { landingFault } from './diagnose.js';
import { landingSpan } from '../../../../resources/index.js';
import { externalGuards } from './external.js';

/** A landing gate the batch may land on: green, red only in base main's own cases, or fully waived [C7,#2941]. */
function accepted(state, gate) { return gate.isGreen || Boolean(gate.knownMainProof) || Boolean(waivedProof(state, gate)); }

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
 * Prove a tier-1 batch's actual merged diff with submit's affected map (#1277). Fixed invariants and registry
 * guards remain a floor; an uncertain import graph requires the configured full gate before adoption.
 */
export async function quickGuards(state, label = 'local-trunk', options = {}) {
  const services = state.guardServices ?? {};
  const runChecks = services.runStaticChecks ?? runStaticChecks;
  const smoke = landingSmoke(services);
  const runGate = services.gateGroup ?? gateGroup;
  const proven = provenTreeGate(state.board, state.batch.items, headTree(state.batch.root), { external: state.batch.external === true });
  if (proven) {
    await landingSpan('static', () => runChecks(state.batch.root, state.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, agent: 'coordinator', onWait: state.onWait, runnerAdmission: { landing: true, itemCheck: false, shortEligible: false } }))
      .catch(error => { throw landingStaticRefusal(state.batch.root, state.batch.base, error, state.config.staticChecks); });
    await smoke(state.batch.root, { record: true });
    state.say?.(proven.externalProof
      ? `${proven.externalProof.map(id => `#${id}`).join(', ')}: proven elsewhere by the coordinator; the static checks and smoke ran on the runners, no tests rerun`
      : `#${state.batch.items[0].id}: its submit gate ${proven.reusedSubmitGate} already proved this exact tree green; no tests rerun`);
    return proven;
  }
  // The static checks run beside the gate, not before it: in their own slot they cost a one-item batch about 50 s on
  // the critical path for an 8 s check. A red static check still refuses the batch once the gate has finished [C7].
  // The landing's static check waits as a landing: as an ordinary item check it queued 58 to 211 s behind builder
  // submits on 6 Nov, longer than the gate it was meant to run beside [C7].
  const staticChecks = landingSpan('static', () => runChecks(state.batch.root, state.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, agent: 'coordinator', onWait: state.onWait, runnerAdmission: { landing: true, itemCheck: false, shortEligible: false } })) // a landing slot: not an item check, not a short slot
    .then(result => ({ result }), error => ({ error }));
  let gate;
  try { gate = await runGate(state, label, { localTrunk: true, ...options }); }
  finally { await staticChecks; }
  const checked = await staticChecks;
  if (checked.error) throw landingStaticRefusal(state.batch.root, state.batch.base, checked.error, state.config.staticChecks);
  // A lock wait that ran no case is infra: the landing fault path retries it [C7,#3314].
  if (!gate.isGreen && !waivedProof(state, gate)) requireNoLockOnlyRed(gate);
  // Red only in files the run's watchdog stopped: no test decided against the batch, so it lands [C7,#3167].
  const stopped = !gate.isGreen && !waivedProof(state, gate) ? watchdogProof(state, gate) : null;
  if (stopped) {
    state.say(`watchdog-stopped only (${stopped.watchdogStopped.map(entry => entry.file).join(', ')}); no test is red, the batch lands`);
    return { ...gate, knownMainProof: stopped };
  }
  // A per-item landing never compares main: its one item's red is its own [C7,#2901].
  if (!gate.isGreen && !waivedProof(state, gate) && !singleItemLanding(state)) {
    // Red only in cases base main fails the same way: the batch made main no worse, so it lands [C7,#2941].
    const own = unwaivedFailures(state.board, gate.failures, state.landingPorts);
    const split = own.length && own.every((failure) => failure.file) ? await splitBaseRed(state, own) : null;
    if (split && !split.own.length) {
      state.say(`known main red only (${split.known.length} cases); the batch adds no red`);
      return { ...gate, knownMainProof: { tree: gate.tree, failures: [], knownMain: split.known.map(({ file, name }) => ({ file, name })), logPath: gate.logPath } };
    }
  }
  if (!gate.isGreen && !waivedProof(state, gate) && singleItemLanding(state)) return gate;
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
 * Main moved while the batch gated. When every commit main gained touches no file the batch changes, the batch is
 * rebuilt on the new tip and gated again on its own plan, focused on the tests those commits reach; a move that
 * touches the batch's files, or a rebuilt batch of several items that is red, is refused as before. A rebuilt
 * one-item batch that is red returns its item and resolves null. Why: a 7-item batch that went green
 * after a 51-minute bisection was refused LAND_TRUNK_MOVED for two commits outside its files, and the rebuild re-gated
 * and re-bisected everything [C7].
 */
async function followMovedTrunk(state, gate) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const moved = mainCheckout(state.root)?.commit;
    if (moved === state.batch.base) return gate;
    const names = (from, to) => new Set(git(state.root, ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(Boolean));
    const trunkFiles = names(state.batch.base, moved);
    const batchFiles = names(state.batch.base, state.batch.tip);
    const shared = [...trunkFiles].filter(file => batchFiles.has(file));
    if (shared.length) throw new Refused('LAND_TRUNK_MOVED', `main moved during the landing and changed ${shared.slice(0, 3).join(', ')}; rebuild the batch from its new tip`);
    state.say(`main moved to ${moved.slice(0, 12)} outside this batch's files; rebuilding the batch on it`);
    const previous = state.batch.base;
    await save(state, { base: moved, rebasedFrom: previous });
    const rebuilt = await mergeGroup(state, state.batch.items);
    await save(state, { ...rebuilt });
    const affected = selectAffectedTests(state.root, { base: previous, commit: moved });
    // Only tests whose closure reaches both sides can change; none means the batch's proof holds on the new tip [C7].
    const reruns = trunkMoveReruns(state, { trunkFiles, batchFiles, trunkAffected: affected });
    if (reruns && !reruns.length) {
      state.say(`main's move to ${moved.slice(0, 12)} shares no test closure with this batch; its proof stands on the rebuilt tree`);
      gate = await reusedAcrossMove(state, gate, previous, moved);
      continue;
    }
    const focus = reruns ? { focus: reruns } : !affected.full && affected.files.length ? { focus: affected.files } : {};
    gate = await quickGuards(state, `trunk-moved-${attempt + 1}`, focus);
    if (!accepted(state, gate) && oneItemBatch(state)) {
      // One item's red on the rebuilt tree is that item's, as on its first gate: it returns alone to its builder and
      // the trunk is not held. Why: #3768 went red three times at "gate trunk-moved-N" and held every landing (9 Nov) [C7].
      await returnCulprit(state, state.batch.items[0], namedFailures(gate), { isolated: Boolean(gate.complete) });
      await save(state, { state: 'blocked', failures: gate.failures, culprits: state.culprits });
      return null;
    }
    if (!accepted(state, gate)) throw new Refused('LAND_TRUNK_MOVED', `main moved during the landing and the batch rebuilt on ${moved.slice(0, 12)} is red in ${[...new Set((gate.failures ?? []).map(failure => failure.file).filter(Boolean))].slice(0, 3).join(', ') || 'its gate'}; rebuild the batch from its new tip`);
  }
  if (mainCheckout(state.root)?.commit !== state.batch.base) throw new Refused('LAND_TRUNK_MOVED', 'main moved twice during the landing; rebuild the batch from its new tip');
  return gate;
}

/**
 * The batch's gate carried onto the tree rebuilt on main's move, after the static checks and the CLI smoke on that
 * tree, which read every file and so are never reused. The gate keeps its log and names the move it was carried over.
 */
async function reusedAcrossMove(state, gate, from, to) {
  const services = state.guardServices ?? {};
  const runChecks = services.runStaticChecks ?? runStaticChecks;
  await Promise.all([
    runChecks(state.batch.root, state.config, { executionServices: { runners: runnerExecutionServices(), landing: landingExecutionServices() }, agent: 'coordinator', onWait: state.onWait, runnerAdmission: { landing: true, itemCheck: false, shortEligible: false } })
      .catch(error => { throw landingStaticRefusal(state.batch.root, state.batch.base, error, state.config.staticChecks); }),
    landingSmoke(services)(state.batch.root, { record: true }),
  ]);
  return { ...gate, tree: headTree(state.batch.root), carriedAcrossMove: { from, to, tree: gate.tree } };
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

export async function landOnTrunk(state) {
  await save(state, { state: 'gating', tip: headCommit(state.batch.root) });
  let gate;
  try {
    gate = state.batch.external ? await externalGuards(state, quickGuards) : await quickGuards(state);
    if (!gate) { await save(state, { state: 'blocked', culprits: state.culprits }); return; }
    if (gate.interaction) throw new Refused('LAND_INTERACTION', 'the individually green items fail the static checks together; nothing lands; inspect the batch’s static rows');
    if (!accepted(state, gate) && singleItemLanding(state)) {
      // One item's red sends that item alone back to open with the evidence; no bisection, no trunk hold [C7,#2901].
      // A complete gate had its known-main account: what remains red is the one item's, in any file [C7].
      await returnCulprit(state, state.batch.items[0], namedFailures(gate), { isolated: Boolean(gate.complete) });
      await save(state, { state: 'blocked', failures: gate.failures, culprits: state.culprits });
      return;
    }
    if (!accepted(state, gate)) {
      const own = unwaivedFailures(state.board, gate.failures, state.landingPorts);
      const flakyFiles = await diagnose(state, own, gate);
      if (flakyFiles.length) { await fileFlakes(state, gate, flakyFiles); state.flaky = true; return; }
      if (await splitRedBatch(state, gate)) return;
      const green = await bisect(state, state.batch.items, own, 'local-split', quickGuards);
      if (state.flaky || !green.length) {
        if (!state.flaky) await save(state, { state: 'blocked', culprits: state.culprits });
        return;
      }
      const rebuilt = await mergeGroup(state, green);
      await save(state, { ...rebuilt, culprits: state.culprits });
      gate = await quickGuards(state, 'local-green-items');
      if (!accepted(state, gate)) {
        if (!state.culprits.length) { await fileTestDefects(state, gate); state.flaky = true; return; }
        await save(state, { state: 'blocked', failures: gate.failures, culprits: state.culprits });
        throw new Refused('LAND_INTERACTION', 'the individually green items fail together; nothing retries or lands; inspect the batch’s failing tests');
      }
    }
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    // A landing fault keeps the batch merging or gating with its worktree, so the next wake adopts and resumes it [C7].
    if (landingFault(error)) throw error;
    if (oneItemBatch(state) && await returnRefusedItem(state, error)) {
      await save(state, { state: 'blocked', ...refusalRecord(state.batch, error, state.board.clock.now().toISOString()) });
      state.say(`nothing landed: ${error.message}`);
      return;
    }
    // The refusal is kept with its code so a RUNNER_SOURCE count across these blocked batches can hold the items [C7].
    if (!['flaky', 'test-defect'].includes(state.batch.state)) await save(state, { state: 'blocked', failures: [{ file: null, name: error.message }], ...refusalRecord(state.batch, error, state.board.clock.now().toISOString()) });
    state.say(`nothing landed: ${error.message}`);
    return;
  }
  for (const entry of state.batch.items) {
    const item = store.getItem(state.board, entry.id);
    requireOutsideOwner(state.board, item);
    if (!state.batch.external && (item.item_status !== 'verified' || item.item_commit !== entry.commit)) throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} changed after the batch merged; rebuild its landing`);
  }
  gate = await landingSpan('follow trunk', () => followMovedTrunk(state, gate));
  if (!gate) return; // The rebuilt tree was red and its one item went back to its builder.
  const proof = landingProof(gate, () => gate.knownMainProof ?? waivedProof(state, gate));
  if (!proof) throw new Refused('LAND_WAIVER', 'the local-trunk red lost its live person waiver; ask the person for a new expiring waiver, then adopt the batch');
  state.say('trunk: gate proved; binding the flake ratchet');
  if (!await flakeRatchetOrBlock(state)) return;
  state.say('trunk: ratchet bound; recording trunk and finishing');
  await save(state, { state: 'trunk', proof });
  await finishTrunk(state);
}
