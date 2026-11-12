import { retryableLandingBatch } from '../../logic/retry.js';
/** Coordinator landing batch step; source-preserving partition of land.js [B3,R3,C7]. */
import { requirePublishGreen } from '../pause.js';
import { replayDeferredNotices } from '../deferred/notices.js';
import { cadenceApplies } from '../../logic/cadence.js';
import { cadenceDeferral } from '../../logic/cadence.js';
import { requireOutsideOwner } from '../../../../items/index.js';
import { mechanicalConflictFiles } from '../../../../merge/index.js';
import { warnMainMoved } from '../../../../merge/index.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';
import * as store from '../../../../store/index.js';
import { git } from '../../../../git/index.js';
import { tryGit } from '../../../../git/index.js';
import { isClean } from '../../../../git/index.js';
import { invalidateGitFacts } from '../../../../git/index.js';
import { mainCheckout } from '../../../../git/index.js';
import { repoInfo } from '../../../../git/index.js';
import { untracked } from '../../../../git/index.js';
import { takeLandingResource } from '../resource.js';
import { landingSpan } from '../../../../resources/index.js';
import { requireConfirmedLanding } from '../../../../store/index.js';
import { inheritedGateSlot } from '../../../../resources/index.js';
import { Refused } from '../../../../kernel/index.js';
import { checkLandingMessages } from '../../logic/message.js';
import { heldBatchEntries } from '../../logic/hold.js';
import { refusalRecord } from '../../logic/hold.js';
import { repeatedLandingHold } from '../../logic/hold.js';
import { repeatedLandingHoldCleared } from '../../logic/hold.js';
import { landingContext } from '../../logic/message.js';
import { requireLandingHost } from '../host.js';
import { policyAt } from '../../../../sandbox/index.js';
import { staleVerdictRefusal } from '../../../../verify/index.js';
import { candidates } from './selection.js';
import { relandAcceptedItems } from '../reland.js';
import { closePassedTestDefects } from './selection.js';
import { landingMaximum } from './selection.js';
import { singleItemLanding } from './selection.js';
import { oneItemBatch } from './selection.js';
import { idleLanding } from './selection.js';
import { emptyLanding } from './selection.js';
import { landingOperations } from './merge.js';
import { landingEntry } from './selection.js';
import { save } from './merge.js';
import { splitRedBatch } from './split.js';
import { mergeGroup } from './merge.js';
import { gateGroup } from './gate.js';
import { parallelLanding } from './parallel.js';
import { diagnose } from './diagnose.js';
import { waivedProof } from './failures.js';
import { bisect } from './diagnose.js';
import { returnCulprits } from './diagnose.js';
import { returnMergeConflicts } from './diagnose.js';
import { returnCulprit } from './diagnose.js';
import { namedFailures } from './diagnose.js';
import { returnRefusedItem } from './diagnose.js';
import { parkRepeatedItem } from './diagnose.js';
import { compareMainFailures } from '../main/red.js';
import { landingFault } from './diagnose.js';
import { fileFlakes } from './diagnose.js';
import { fileTestDefects } from './diagnose.js';
import { requirePushTarget } from './publish.js';
import { startBaseRefresh } from './publish.js';
import { publish } from './publish.js';
import { landsOnTrunk } from './publish.js';
import { inlineDeferredGuards } from './trunk.js';
import { landOnTrunk } from './trunk.js';
import { flakeRatchetBeforeGate } from './trunk.js';
import { finishTrunk } from './publish.js';
import { timedPhase } from '../timing.js';

/** Require a separate admitted slot for every speculative gate, without holding a parent gate open. */
function requireParallelGateAdmission(root, config) {
  if (config.landing?.parallel === true && inheritedGateSlot({ root, namedFiles: true })) {
    throw new Refused('LAND_PARALLEL_NESTED_GATE', 'parallel landing needs separately admitted gate slots; run pullboard land outside the current gate command');
  }
}

/** Name this machine on the public board by a digest, never by its host name. */
export function landingHost(name = hostname()) {
  return createHash('sha256').update(name).digest('hex').slice(0, 16);
}

/** True when an unfinished batch's recorded landing process still runs on this machine; a foreign or unrecorded one is judged by the lease alone. */
export function landingProcessLive(batch, { host = landingHost(), probe = pid => process.kill(pid, 0) } = {}) {
  const pid = batch.pid ?? Number(/^pid-([1-9][0-9]*)$/u.exec(batch.owner ?? '')?.[1] ?? 0);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid || (batch.host && batch.host !== host)) return false;
  try { probe(pid); return true; } catch (error) { return error.code === 'EPERM'; }
}

/**
 * Automatic landing adopts a batch whose landing process is gone, so a crash never deadlocks landing [B35,B3].
 * Why the lease is enough: this command holds the board's exclusive landing lease, so no live process can own the batch
 * unless its recorded pid still runs here. A batch whose worktree is gone cannot resume and is blocked.
 */
function adoptInterrupted(unfinished, { automatic, fence, say }) {
  if (!automatic || !fence || !unfinished || ['flaky', 'test-defect'].includes(unfinished.state)) return null;
  if (landingProcessLive(unfinished)) throw new Refused('LAND_ADOPT', `batch ${unfinished.id} is ${unfinished.state} under live process ${unfinished.pid ?? unfinished.owner}; automatic landing leaves it alone until it ends`);
  const kept = ['pushed', 'ready', 'trunk'].includes(unfinished.state);
  // Only a missing worktree is lost. A gate saves 'gating' before its log exists, and resuming re-merges and re-gates (#3013).
  const lost = !kept && !existsSync(unfinished.root);
  say(`landing adopts interrupted batch ${unfinished.id} (${unfinished.state})${lost ? '; its worktree or log is gone, so it is blocked and a fresh batch starts' : ''}`);
  return { lost };
}

/**
 * The landing's checks before its lease: lift cleared holds, refuse a red publish, close passed test defects, return
 * relanded items, apply the cadence and preflight the selection. Returns `{ result }` when the landing ends here,
 * else `{ publishHold }` for the selection after the lease.
 */
async function preflightLanding(options, trunk, branch) {
  if (trunk.commit && !options.dryRun && !options.adopt) {
    await releaseClearedRepeatHolds(options.root, options.board, trunk, options.write, options.onWait);
  }
  let publishHold = null;
  if (trunk.commit) {
    const policy = policyAt(options.root, trunk.commit).config;
    requireParallelGateAdmission(options.root, policy);
    publishHold = requirePublishGreen(options.root, options.board, policy, options.landingPorts, { perItem: true });
  }
  // A defect whose cases passed at this trunk closes for good, before any later landing moves the tip past that run (#3694).
  if (trunk.commit) await closePassedTestDefects({ root: options.root, board: options.board, trunk, write: options.write, say: options.say, onWait: options.onWait, landingPorts: options.landingPorts });
  // A named landing is the coordinator's own call: it relands, defers and selects nothing else [C7,#5559].
  if (options.named) return { publishHold };
  if (trunk.commit && !options.adopt) await relandAcceptedItems({ ...options, base: trunk.commit });
  if (trunk.commit && !options.adopt) {
    requireConfirmedLanding(options.board);
    if (cadenceApplies(options) && (!options.due || idleLanding(options.board, trunk.commit))) {
      const deferred = cadenceDeferral(options.board, policyAt(options.root, trunk.commit).config, branch, options.say, options.due);
      if (deferred) return { result: deferred };
    }
  }
  if (trunk.commit && !options.adopt && idleLanding(options.board, trunk.commit)) {
    requireConfirmedLanding(options.board);
    // Only accepted trunk policy may inform this read-only preflight.
    const config = policyAt(options.root, trunk.commit).config;
    options.board.quarantineEnabled = () => config.flakes?.quarantine === true;
    const selected = candidates(options.board, options.root, trunk.commit, landingMaximum(options.board, config, options.maximum, options.automatic === true), { firstReady: true, landingPorts: options.landingPorts, first: config.landing?.first ?? [], redFiles: publishHold?.files ?? [] });
    invalidateGitFacts();
    const current = mainCheckout(options.root);
    if (publishHold && !selected.ready.length) throw publishHold.refusal;
    if (!selected.ready.length && current?.commit === trunk.commit && current.branch === branch
      && idleLanding(options.board, trunk.commit)) {
      requireConfirmedLanding(options.board);
      return { result: emptyLanding(selected, options.say) };
    }
  }
  return { publishHold };
}

/** Build, gate, diagnose and durably land one coordinator batch; all external actions stay in its worktree. */
export async function land(options) {
  options = { ...options, landingPorts: landingOperations(options.landingPorts) };
  if (options.dryRun) return runLandingBatch(options);
  invalidateGitFacts();
  const trunk = mainCheckout(options.root);
  const branch = trunk?.branch;
  if (!branch) throw new Refused('LAND_TRUNK', 'landing needs the coordinator’s primary branch; return its checkout to the trunk');
  // Everything before the lease is one span: the 9 Nov traces lost 3 to 5 minutes here before any batch began [C7].
  const { result: early } = await landingSpan('preflight', () => preflightLanding(options, trunk, branch));
  if (early) return early;
  let lastWait = '';
  const controller = new AbortController();
  const lease = await landingSpan('lease', () => takeLandingResource({ board: options.board, write: options.write, refresh: options.refresh, branch,
    onLost: error => controller.abort(error),
    /** Report a real ordered holder, without allocating machine test capacity to this waiter. */
    onWait({ holders, position }) {
      const holder = holders[0];
      const elapsed = holder ? Math.max(0, Math.floor((options.board.clock.now().getTime() - Date.parse(holder.since)) / 1000)) : 0;
      const message = `landing waiting: ${branch} held by ${holder?.label ?? 'the previous landing'} on ${holder?.machine ?? (holder?.lineage ? 'the recorded coordinator machine (legacy identity)' : 'this machine')} for ${elapsed}s; queued at place ${position}; foreign holders require explicit release or pullboard takeover`;
      if (message !== lastWait) options.say(message);
      lastWait = message;
    } }));
  let failed = false;
  try {
    await lease.assertHeld(); await lease.guard(controller); // The guardian stops a gate this command can no longer own.
    invalidateGitFacts(); // The holder may have moved main while this command waited.
    /** Bind each batch transition to this acknowledged grant, never to an optimistic local result. */
    const write = async (operation, args) => {
      await lease.assertHeld();
      const values = ['recordTrainLanding', 'recordLandingBatch', 'finishLandingBatch'].includes(operation)
        ? [{ ...args[0], landingFence: lease.fence }, ...args.slice(1)] : args;
      return options.write(operation, values);
    };
    /** Relay catch-up can change proof or trunk facts while a renewal awaits its receipt. */
    const checkLease = async () => { await lease.assertHeld(); invalidateGitFacts(); };
    const batchOptions = { root: options.root, config: options.config, owner: options.owner, maximum: Number.isFinite(options.maximum) ? options.maximum : null,
      ...(options.named ? { named: options.named } : {}), adopt: options.adopt, automatic: options.automatic === true, due: options.due, fence: lease.fence };
    if (batchOptions.maximum === null) delete batchOptions.maximum;
    /** A batch with no progress for the stall limit is recorded blocked; its items stay verified for the next batch. */
    const onStall = async ({ batch, description }) => {
      const current = store.landingBatches(options.board).findLast(row => row.id === batch.id);
      if (!current) throw new Refused('LAND_STALLED', `${description}; its batch record is missing, inspect pullboard resume`);
      const blocked = await write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...current, state: 'blocked',
        refusal: { code: 'LAND_STALLED', message: description, at: options.board.clock.now().toISOString() } }, revision: current.revision ?? 0 }]);
      options.say(`landing stopped: ${description}; items remain verified and the next batch can start`);
      return { batch: blocked, landed: [], conflicts: [], blocked: blocked.blocked ?? [], culprits: [], flakes: [], stalled: true, stallDescription: description };
    };
    // The batch runs in this process through the drive cell's runner; there is no spawned landing worker [C7].
    if (typeof options.runBatch !== 'function') throw new Refused('LAND_RUNNER', 'landing needs its in-process batch runner: pass { runBatch: inProcessLandingBatch(...) }');
    return await landingSpan('batch', () => options.runBatch(batchOptions, { board: options.board, landingPorts: options.landingPorts, write, checkLease, checkLeaseNow: lease.assertCurrent, onWait: options.onWait, onStall, say: options.say, signal: controller.signal }));
  } catch (error) {
    failed = true;
    // A gate stopped by the guardian's or the lease's loss fails on its own; the loss is the cause (#5770).
    throw controller.signal.aborted && ['LAND_WORKER', 'LAND_LEASE_LOST'].includes(controller.signal.reason?.code) ? controller.signal.reason : error;
  }
  finally {
    try { await lease.release(); }
    catch (error) {
      if (!failed) throw error;
      options.say(`landing lease release was not acknowledged: ${error.code ?? 'ERROR'}; inspect pullboard resume before adopting`);
    }
  }
}

/**
 * Drop an unpublished batch whose every item already has a merged commit from another path, removing its worktree.
 * Why: nothing could drop such a batch, so automatic landing kept adopting and retrying work already on main (#2624).
 */
async function dropLandedElsewhere(root, board, write, say, batch) {
  const entries = batch.candidates ?? batch.items ?? [];
  if (['pushed', 'trunk'].includes(batch.state) || !entries.length || !entries.every(entry => store.getItem(board, entry.id)?.item_merged_commit)) return false;
  await write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, state: 'blocked', dropped: 'every item already landed another way' }, revision: batch.revision }]);
  if (existsSync(batch.root)) tryGit(root, ['worktree', 'remove', '--force', '--', batch.root]);
  say(`landing dropped batch ${batch.id}: ${entries.map(entry => `#${entry.id}`).join(', ')} already landed`);
  return true;
}

/**
 * Whether a batch already reached its trunk: pushed, or a 'trunk' batch whose items carry merged receipts or whose
 * tip main already names. Why: 'trunk' is saved before its receipts and the trunk move, so a crash there leaves the
 * items verified and unmerged, and treating it as published let a held item land on adoption (#2648).
 */
function batchPublished(root, board, batch) {
  if (batch.state === 'pushed') return true;
  if (batch.state !== 'trunk') return false;
  const entries = batch.items ?? batch.candidates ?? [];
  return mainCheckout(root)?.commit === batch.tip || (entries.length > 0 && entries.every(entry => store.getItem(board, entry.id)?.item_merged_commit));
}

/**
 * Retire an unpublished batch that carries a held item or one whose RUNNER_SOURCE retries are used up, keeping why.
 * Why: adopting resumes the batch's recorded items without selection, so a hold or the retry limit never applied to
 * it, and every wake retried the same refused batch (#2648).
 */
async function retireHeldBatch(root, board, write, say, batch) {
  if (batchPublished(root, board, batch)) return false;
  const held = heldBatchEntries(store.landingBatches(board), batch, id => store.getItem(board, id));
  if (!held.length) return false;
  await write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, state: 'blocked', blocked: [...(batch.blocked ?? []), ...held] }, revision: batch.revision }]);
  for (const entry of held) say(`landing retires batch ${batch.id}: ${entry.code} #${entry.id}: ${entry.message}`);
  return true;
}

/** True for a failure that is no refusal and no lost lease: a crash of the landing code itself [C7,#3188]. */
export function isCrash(error) {
  return !(error instanceof Refused) && error?.code !== 'LAND_LEASE_LOST';
}

/** The refusal to record for an error: a crash becomes LAND_WORKER_CRASH carrying its stack, a refusal stays as raised [C7,#3188]. */
export function crashRefusal(error) {
  return isCrash(error) ? { code: 'LAND_WORKER_CRASH', message: String(error?.stack ?? error) } : error;
}

/**
 * End the batch blocked after any refusal or crash in a landing step (merge, gate, diagnose, trunk, publish), so the next
 * batch starts and no restart adopts and gates it again. Only a lost lease keeps it, since another worker owns the batch then;
 * a landing fault such as BOARD_BUSY is a Refused like any other and blocks it too (its items stay verified).
 * The exception is LAND_DIAGNOSTIC on a multi-item batch with no named failure, which stays adoptable so the third unnamed red splits it [C7,#2858].
 * Why: FLAKE_RATCHET escaped with the batch still gating and killed the worker 50 times on 5 Nov [C7,#3188].
 */
export async function blockAfterRefusal(state, error) {
  // A multi-item batch whose gate named no failing file stays adoptable: its unnamed-red count is what makes the third red split the items [C7,#2858].
  const splittable = error?.code === 'LAND_DIAGNOSTIC' && (state.batch.items?.length ?? 0) > 1 && !(state.batch.failures ?? []).length;
  const refused = error instanceof Refused && !['LAND_LEASE_LOST', 'LAND_WORKER'].includes(error.code) && !splittable;
  if ((refused || isCrash(error)) && ['merging', 'gating', 'ready', 'trunk'].includes(state.batch.state)) await save(state, { state: 'blocked' });
}

/**
 * Record a refusal on the batch and keep every earlier one; a batch whose items used up their RUNNER_SOURCE retries
 * stops blocked with them held, so nothing adopts it again.
 */
async function recordRefusal(state, error) {
  const record = refusalRecord(state.batch, error, state.board.clock.now().toISOString());
  const next = { ...state.batch, ...record };
  const batches = store.landingBatches(state.board).map(batch => (batch.id === next.id ? next : batch));
  const held = record.refusal.code === 'RUNNER_SOURCE' ? heldBatchEntries(batches, next, id => store.getItem(state.board, id)) : [];
  await save(state, { ...record, ...(held.length ? { state: 'blocked', blocked: [...(state.batch.blocked ?? []), ...held] } : {}) });
  for (const entry of held) state.say(`${entry.code} #${entry.id}: ${entry.message}`);
  for (const entry of state.batch.items ?? state.batch.candidates ?? []) {
    const item = store.getItem(state.board, entry.id);
    if (item) await parkRepeatedItem(state, { id: entry.id, item_commit: entry.commit, commit: entry.commit });
  }
}

/**
 * Reopen each item selection set aside as red in its last LANDING_RED_LIMIT batches at the same commit: its accept is
 * withdrawn and it returns to its builder with the count, instead of being gated red again [C7].
 */
export async function returnRepeatedReds(board, selected, write, say) {
  const kept = [];
  for (const entry of selected.blocked) {
    const item = entry.code === 'LAND_REPEATED_RED' ? store.getItem(board, entry.id) : null;
    if (!item || item.item_status !== 'verified' || item.item_merged_commit || item.item_commit !== entry.commit) { kept.push(entry); continue; }
    const note = `landing ${entry.message}; fix the failing tests named in its landing batches, commit and resubmit`;
    try {
      await write('reopen', [entry.id, { agentId: 'coordinator', withdrawVerdict: true, note }]);
      say(`LAND_REPEATED_RED #${entry.id} reopened to its lane: ${entry.message}`);
      kept.push({ ...entry, code: 'REPEATED_RED_REOPENED', message: note });
    } catch (error) {
      say(`LAND_REPEATED_RED #${entry.id} could not be reopened: ${error?.code ?? 'ERROR'} ${String(error?.message ?? '').slice(0, 160)}`);
      kept.push(entry);
    }
  }
  selected.blocked = kept;
}

/**
 * Reopen each candidate whose verdict a concrete main change made stale: the accept is withdrawn, the item reopens
 * with no owner and the changed file named, and its blocked entry becomes STALE_REOPENED. A moved landing, a legacy
 * unsealed review or unreadable history keeps the refusal, since those are not a plain main change [B3,C7].
 */
export async function returnStaleVerdicts(board, selected, write, say) {
  const kept = [];
  for (const entry of selected.blocked) {
    const plain = entry.code === 'STALE_VERDICT' && entry.file && entry.commit && !entry.landingCode && !entry.legacy;
    const item = plain ? store.getItem(board, entry.id) : null;
    if (!item || item.item_status !== 'verified' || item.item_merged_commit) { kept.push(entry); continue; }
    const where = `${entry.file} changed on main in ${entry.commit.slice(0, 12)}`;
    const note = `verdict stale: ${where}, so the reviewed change no longer composes unchanged; merge current main, commit and resubmit`;
    try {
      await write('reopen', [entry.id, { agentId: 'coordinator', withdrawVerdict: true, note }]);
      say(`STALE_VERDICT #${entry.id} reopened to its lane: ${where}`);
      kept.push({ ...entry, code: 'STALE_REOPENED', message: note });
    } catch (error) {
      say(`STALE_VERDICT #${entry.id} could not be reopened: ${error?.code ?? 'ERROR'} ${String(error?.message ?? '').slice(0, 160)}`);
      kept.push(entry);
    }
  }
  selected.blocked = kept;
}

/** Select only after admission, retaining the existing batch, proof and adoption rules. */
export async function runLandingBatch({ root, board, config, write, say, owner, maximum = Infinity, dryRun = false, adopt = false, automatic = false, due = false, onWait, checkLease, checkLeaseNow, fence, checkAtCommit, candidateWorkerFile, landingPorts, spawnRefresh, named = null }) {
  landingPorts = landingOperations(landingPorts);
  let trunk = mainCheckout(root);
  if (fence && trunk?.branch !== fence.branch) throw new Refused('LAND_LEASE_LOST', 'the trunk branch changed while landing waited; start a new land command for its current branch');
  const publishHold = !dryRun && trunk?.commit ? requirePublishGreen(root, board, policyAt(root, trunk.commit).config, landingPorts, { perItem: true }) : null;
  const batches = store.landingBatches(board);
  let unfinished = batches.findLast((batch) => batch.state !== 'landed' && batch.state !== 'blocked');
  if (!unfinished && automatic) unfinished = batches.findLast(batch => retryableLandingBatch(batch, trunk?.commit));
  // A dropped batch leaves nothing to adopt; the run continues as an ordinary landing.
  if (!dryRun && unfinished && await dropLandedElsewhere(root, board, write, say, unfinished)) { unfinished = null; adopt = false; }
  if (fence && unfinished && unfinished.branch !== fence.branch) throw new Refused('LAND_LEASE_LOST', 'the interrupted batch belongs to another trunk branch; restore that branch and start a fresh land --adopt');
  if (!dryRun && unfinished) for (const entry of unfinished.items ?? []) requireOutsideOwner(board, store.getItem(board, entry.id));
  const recorded = store.landingBatches(board).findLast((batch) => batch.state === 'landed' && batch.base === trunk?.commit);
  if (fence && recorded && recorded.branch !== fence.branch) throw new Refused('LAND_LEASE_LOST', 'the recorded Git repair belongs to another trunk branch; restore that branch before landing');
  if (!dryRun && recorded && isClean(root) && !untracked(root).length) {
    await checkLease();
    git(root, ['merge', '--ff-only', recorded.tip]);
    trunk = mainCheckout(root);
  }
  if (!trunk?.commit) throw new Refused('LAND_TRUNK', 'landing needs the coordinator’s primary branch; return its checkout to the trunk');
  // Pin accepted policy after any recorded-landed repair, never before admission or from candidate files.
  config ??= policyAt(root, trunk.commit).config;
  if (!dryRun) requireParallelGateAdmission(root, config);
  board.quarantineEnabled = () => config.flakes?.quarantine === true;
  // A main-moved notice that failed on an earlier wake is retried first, so a seat is not left without its stale-verdict notice (#3367).
  if (!dryRun) await replayDeferredNotices({ root, say }, trunkCommit => warnMainMoved({ root, board, trunk: trunkCommit, write, say }, { listAgents: store.listAgents, listItems: store.listItems }));
  const environment = dryRun ? null : requireLandingHost(store.boardId(board), config);
  // A recorded test defect is a repair item, never a trunk hold: lander v2 judges each red instead [C7,#5862].
  if ((!dryRun || due) && !adopt && !unfinished && !named && cadenceApplies({ automatic, due })) {
    const deferred = cadenceDeferral(board, config, trunk.branch, say, due);
    if (deferred) return deferred;
  }
  if (!dryRun && !adopt) await releaseClearedRepeatHolds(root, board, trunk, write, onWait);
  if (named && !landsOnTrunk(config)) throw new Refused('LAND_NAMED', 'a named landing moves the local trunk; set landing.publish to "separate" or land the items through the ordinary train');
  const selected = candidates(board, root, trunk.commit, named ? named.length : landingMaximum(board, config, maximum, automatic), { landingPorts, first: config.landing?.first ?? [], redFiles: publishHold?.files ?? [], named });
  if (named) requireNamedLandable(board, named, selected);
  if (!dryRun) for (const item of selected.ready) requireOutsideOwner(board, item);
  checkLandingMessages(selected.ready, landingContext(root, trunk.commit, config, (item) => item.item_landing_commit));
  // A verdict gone stale under a main change returns to its lane at once, so next offers it to any builder. Why: on
  // 5 Nov seven accepted items sat up to 30 h with this refusal logged every wake and no seat told [B3,C7].
  if (!dryRun) await returnStaleVerdicts(board, selected, write, say);
  if (!dryRun) await returnRepeatedReds(board, selected, write, say);
  const stale = selected.blocked.find(item => item.code === 'STALE_VERDICT');
  if (!selected.ready.length && stale) throw staleVerdictRefusal({ item_id: stale.id }, stale);
  if (publishHold && !selected.ready.length) throw publishHold.refusal;
  if (dryRun) {
    if (selected.ready.length && !landsOnTrunk(config)) requirePushTarget(root, trunk.branch);
    const conflicts = [];
    for (const item of selected.ready) {
      const files = mechanicalConflictFiles(root, trunk.commit, item.item_landing_commit);
      if (files === null) throw new Refused('LAND_MERGE', 'Git could not preview the landing; restore its objects and retry the dry run');
      if (files.length) conflicts.push({ id: item.item_id, files });
    }
    return { batch: null, landed: [], conflicts, blocked: selected.blocked, culprits: [], flakes: [], items: selected.ready.map((item) => item.item_id) };
  }
  const interrupted = !dryRun && !adopt ? adoptInterrupted(unfinished, { automatic, fence, say }) : null;
  if (interrupted) adopt = true;
  if (unfinished && !adopt && !['flaky', 'test-defect'].includes(unfinished.state)) throw new Refused('LAND_ADOPT', `batch ${unfinished.id} is ${unfinished.state}; inspect pullboard resume, then run pullboard land --adopt`);
  if (adopt && !unfinished) throw new Refused('LAND_ADOPT', 'there is no interrupted landing batch; run pullboard land');
  let batch = unfinished;
  if (batch && interrupted && process.env.PULLBOARD_LANDING_ADOPTION) {
    let adoptedFrom = null;
    try { adoptedFrom = JSON.parse(process.env.PULLBOARD_LANDING_ADOPTION); } catch { /* an unreadable note records nothing */ }
    // The adoption is persisted on the batch itself, so the dead pid and the gap outlive this worker (#2912).
    if (adoptedFrom) batch = await write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, adoptedFrom }, revision: batch.revision }]);
  }
  // A flaky or test-defect batch is retired blocked, so a fresh batch starts: its flakes and defects are records and
  // repair items, never a trunk hold. Why: LAND_FLAKE held every landing behind one flaky file [C7,#5862].
  if (batch && ['flaky', 'test-defect'].includes(batch.state)) {
    await write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, state: 'blocked', retiredFrom: batch.state }, revision: batch.revision }]);
    batch = null;
  }
  if (batch && batch.base !== trunk.commit && batch.state !== 'pushed') {
    await write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, state: 'blocked', supersededByMain: trunk.commit }, revision: batch.revision }]);
    batch = null;
  } else if (batch && interrupted?.lost) {
    await write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, state: 'blocked', refusal: { code: 'LAND_WORKTREE', message: 'the recorded landing worktree is missing or unfinished', at: board.clock.now().toISOString() } }, revision: batch.revision }]);
    batch = null;
  }
  if (batch && await retireHeldBatch(root, board, write, say, batch)) batch = null;
  // An acceptance that adopts an interrupted batch joins the ready work selected at this same main snapshot.
  if (batch && interrupted && selected.ready.length) {
    const candidates = batch.candidates ?? batch.items ?? [];
    const known = new Set(candidates.map(entry => entry.id));
    const arrivals = selected.ready.filter(item => !known.has(item.item_id)).map(landingEntry);
    if (arrivals.length) batch = await write('recordLandingBatch', [{ agentId: 'coordinator',
      batch: { ...batch, candidates: [...candidates, ...arrivals] }, revision: batch.revision }]);
  }
  if (!batch && !selected.ready.length) return emptyLanding(selected, say);
  if (!batch) {
    if (!landsOnTrunk(config)) requirePushTarget(root, trunk.branch);
    const id = randomUUID();
    const directory = join(repoInfo(root).commonDir, 'pullboard', 'landings', id);
    batch = { version: 1, id, startedAt: new Date().toISOString(), base: trunk.commit, tip: trunk.commit, branch: trunk.branch, root: join(directory, 'worktree'),
      ...(environment ? { environment } : {}),
      candidates: selected.ready.map(landingEntry),
      items: selected.ready.map(landingEntry), conflicts: [], blocked: selected.blocked,
      ...(named ? { external: true } : {}),
      state: 'merging', owner, pid: process.pid, host: landingHost(), logPath: join(directory, 'logs', 'batch.log'), revision: 0 };
    batch = await write('recordLandingBatch', [{ agentId: 'coordinator', batch }]);
    mkdirSync(directory, { recursive: true });
    git(root, ['worktree', 'add', '--detach', batch.root, batch.base]);
    // A base with no cached main-red generation gets its refresh now, once, recorded on the batch [C7,#3268].
    const refreshStarted = (spawnRefresh ?? startBaseRefresh)({ root, say }, batch);
    if (refreshStarted) batch = await write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, refreshStarted }, revision: batch.revision }]);
  }
  const state = { root, board, config, write, say, onWait, checkLease, checkLeaseNow, fence, batch, checkAtCommit, candidateWorkerFile, landingPorts, culprits: batch.culprits ?? [], flaky: false, gates: new Map((batch.gateResults ?? []).map((result) => [result.tree, result])), diagnosed: new Map((batch.diagnostics ?? []).map((result) => [result.test, result.isGreen])) };
  try {
    await save(state, { owner, pid: process.pid, host: landingHost(), refusal: null });
    await returnCulprits(state);
    if (state.batch.state === 'trunk') await finishTrunk(state);
    else if (state.batch.state === 'pushed' || state.batch.state === 'ready') await publish(state);
    else {
      await flakeRatchetBeforeGate(state);
      const initialItems = (state.batch.candidates ?? state.batch.items)
        .filter((entry) => !state.culprits.some((culprit) => culprit.id === entry.id && culprit.commit === entry.commit));
      if (!existsSync(state.batch.root)) throw new Refused('LAND_WORKTREE', `the recorded landing worktree is missing at ${state.batch.root}; restore it before adopting`);
      if (state.config.landing?.parallel === true && !state.batch.external) {
        await parallelLanding(state, initialItems);
        await returnMergeConflicts(state);
        return { batch: state.batch, landed: state.batch.state === 'landed' ? state.batch.items.map(entry => entry.id) : [],
          conflicts: state.batch.conflicts ?? [], blocked: state.batch.blocked ?? [], culprits: state.culprits, flakes: state.batch.flakes ?? [] };
      }
      const build = await timedPhase(say, 'merge', () => mergeGroup(state, initialItems));
      await save(state, { ...build, conflicts: [...state.batch.conflicts, ...build.conflicts] });
      for (const entry of state.batch.blocked ?? []) say(entry.code === 'LAND_FILE_OVERLAP'
        ? `#${entry.id} waits on overlapping files ${entry.files.join(', ')}; once this batch lands, its reviewer must merge current main and re-accept it without reopening`
        : `${entry.code} #${entry.id}${entry.stacked ? ` carries #${entry.stacked}` : ''}${entry.message ? `: ${entry.message}` : ''}`);
      if (!build.items.length) await save(state, { state: 'blocked' });
      else if (landsOnTrunk(state.config)) await landOnTrunk(state);
      else if (!await inlineDeferredGuards(state)) await save(state, { state: 'blocked' });
      else {
        let gate = await gateGroup(state, 'batch');
        let proof = gate.isGreen ? null : gate.knownMainProof ?? waivedProof(state, gate);
        if (!gate.isGreen && !proof && singleItemLanding(state)) {
          // One item's red is its own: it goes back to open with the evidence, with no bisection or hold [C7,#2901].
          await returnCulprit(state, state.batch.items[0], namedFailures(gate), { isolated: Boolean(gate.complete) });
          await save(state, { state: 'blocked', failures: gate.failures, culprits: state.culprits });
          gate = null;
        } else if (!gate.isGreen && !proof) {
          const flakyFiles = await diagnose(state, gate.failures, gate);
          if (flakyFiles.length) { await fileFlakes(state, gate, flakyFiles); state.flaky = true; }
          else if (await splitRedBatch(state, gate)) gate = null;
          else {
            const green = await bisect(state, build.items, gate.failures);
            if (!state.flaky && green.length) {
              const rebuilt = await timedPhase(say, 'merge', () => mergeGroup(state, green));
              await save(state, { ...rebuilt, culprits: state.culprits });
              // The smaller final tree lost the removed items' changes, so the kept items' deferred files run again on it.
              if (!await inlineDeferredGuards(state)) {
                await save(state, { state: 'blocked', culprits: state.culprits });
                gate = null;
              } else {
                gate = await gateGroup(state, 'green-items');
                proof = gate.isGreen ? null : gate.knownMainProof ?? waivedProof(state, gate);
                if (!gate.isGreen && !proof) {
                  if (!state.culprits.length) { await fileTestDefects(state, gate); state.flaky = true; }
                  else {
                    await save(state, { state: 'blocked', failures: gate.failures, culprits: state.culprits });
                    throw new Refused('LAND_INTERACTION', 'the individually green items fail together; nothing retries or lands; inspect the batch’s failing tests');
                  }
                }
              }
            } else if (!state.flaky) await save(state, { state: 'blocked', culprits: state.culprits });
          }
        }
        if (!state.flaky && gate && (gate.isGreen || proof)) {
          await save(state, { state: 'ready', proof: proof ?? { tree: gate.tree, failures: [], logPath: gate.logPath }, culprits: state.culprits });
          await publish(state);
        }
      }
    }
  } catch (error) {
    const crash = isCrash(error);
    if (error.code !== 'LAND_LEASE_LOST' && state.batch.state !== 'landed') {
      try { await recordRefusal(state, crashRefusal(error)); }
      // ERR_INVALID_STATE is node:sqlite's closed handle: the batch was stopped and abandoned, and its stop was recorded.
      catch (noticeError) { say(`landing refusal could not be recorded: ${noticeError.code ?? 'ERROR'}${noticeError.code === 'ERR_INVALID_STATE' ? ' (the board closed under a batch its stop abandoned; the stop was recorded)' : ''}: ${String(noticeError.message ?? '').slice(0, 200)}`); }
    }
    // A per-item refusal of the item's own content sends it back to open; an infrastructure refusal leaves it verified.
    // Either way its unpublished batch stops blocked, so the next run moves on and nothing is held [C7,#2901,#2967].
    const single = state.batch.state !== 'landed' && oneItemBatch(state);
    const returned = state.batch.state !== 'landed' && (single || error.code === 'LAND_MODULE_PARSE') && await returnRefusedItem(state, error);
    // A landing fault (BOARD_BUSY) keeps the batch merging or gating with its worktree and log, so adoption resumes it.
    if (returned || (single && error instanceof Refused && error.code !== 'LAND_LEASE_LOST' && !landingFault(error)
      && ['merging', 'gating'].includes(state.batch.state))) await save(state, { state: 'blocked' });
    if (!returned) await blockAfterRefusal(state, error);
    if (!returned && (!(error instanceof Refused) || error.code !== 'LAND_GATE_TIMEOUT')) throw error;
    say(error.message);
  }
  await returnMergeConflicts(state);
  return { batch: state.batch, landed: state.batch.state === 'landed' ? state.batch.items.map((entry) => entry.id) : [],
    conflicts: state.batch.conflicts ?? [], blocked: state.batch.blocked ?? [], culprits: state.culprits, flakes: state.batch.flakes ?? [] };
}

/**
 * Refuse a named landing that names an item the board does not have, or one already merged or withdrawn.
 * Why: a typo in an id list must stop the whole call before a worktree exists; a held or stacked item is not this
 * refusal, it comes back in the batch's blocked list as for any landing [C7,#5559].
 */
function requireNamedLandable(board, named, selected) {
  const known = new Set([...selected.ready.map(item => item.item_id), ...selected.blocked.map(entry => entry.id)]);
  const missing = named.filter(({ id }) => !known.has(id));
  if (!missing.length) return;
  const reasons = missing.map(({ id }) => {
    const item = store.getItem(board, id);
    return `#${id} ${item ? (item.item_merged_commit ? 'is already merged' : `is ${item.item_status}`) : 'does not exist'}`;
  });
  throw new Refused('LAND_NAMED', `cannot land ${reasons.join('; ')}`, 'name only items on the board that are not merged or withdrawn');
}

/** Lift only automatic repeat holds whose bound refusal context changed or exact case now passes on main. */
async function releaseClearedRepeatHolds(root, board, trunk, write, onWait) {
  for (const item of store.listItems(board, { all: true })) {
    if (!item.item_hold_at || item.item_hold_by !== 'coordinator') continue;
    const hold = repeatedLandingHold(item.item_hold_reason);
    if (!hold) continue;
    let comparison = null;
    if (hold.kind === 'case') {
      const [file] = hold.key.split('::');
      if (!file) continue;
      try {
        comparison = await compareMainFailures(root, { tests: [{ file, passed: false }] }, onWait, '',
          { commit: trunk.commit, detailed: true });
      } catch { comparison = null; }
    }
    /** The refusal's own condition, read from the worktree the refusal named; a vanished worktree is no longer dirty. */
    const facts = hold.kind === 'refusal' && hold.root
      ? { worktreeDirty: existsSync(hold.root) && (!isClean(hold.root) || untracked(hold.root).length > 0) } : null;
    if (repeatedLandingHoldCleared(hold, item, trunk.commit, comparison, facts)) await write('releaseItemHold', [item.item_id, { agentId: 'coordinator' }]);
  }
}
