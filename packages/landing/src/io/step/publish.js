import { fileSystemAdapter } from '../../../../fs/index.js';
import { requireLandingCompanions } from '../guards.js';
import { environmentAdapter } from '../../../../env/index.js';
import { timedPhase } from '../timing.js';
import { requireLandingModuleResolution } from '../guards.js';
import { quarantineBatchGates } from '../../../../verify/index.js';
import { receiptBlockingGreen } from '../../../../verify/index.js';
import { verdictProjector } from '../../../../verify/index.js';
import { landingWaiverFor as nativeLandingWaiverFor } from '../../logic/waivers.js';
/** Coordinator landing publish step; source-preserving partition of land.js [B3,R3,C7]. */
import { finalizeLandingEnvelope } from '../land/envelope.js';
import { prepareNativeTrainLanding } from '../trainrecord.js';
import { finishLanding } from '../finish.js';
import { mergeOnlyLandingProblem } from '../../../../merge/index.js';
import { requireOutsideOwner } from '../../../../items/index.js';
import * as store from '../../../../store/index.js';
import { git } from '../../../../git/index.js';
import { headCommit } from '../../../../git/index.js';
import { headTree } from '../../../../git/index.js';
import { isClean } from '../../../../git/index.js';
import { mainCheckout } from '../../../../git/index.js';
import { repoInfo } from '../../../../git/index.js';
import { sameCommonDir } from '../../../../git/index.js';
import { tryGit } from '../../../../git/index.js';
import { untracked } from '../../../../git/index.js';
import { isStampedGreen } from '../../../../gate/heavy.js';
import { Refused } from '../../../../kernel/index.js';
import { save } from './merge.js';
import { exactTreeRecord } from './merge.js';
import { landingRunObserver } from './gate.js';
import { sprintPorts } from './gate.js';
import { spawn } from 'node:child_process';
import { refreshSource } from '../main/red.js';
import { fileURLToPath } from 'node:url';
import { landingSpan } from '../../../../resources/index.js';
import { claimRefreshStart } from '../main/red/refresh/flight.js';
import { AGENT_SESSION_IDS } from '../../../../kernel/index.js';
import { scanRidesRunner } from '../scan.js';
import { trunkRemote } from '../../../../config/index.js';
import { fencedHopEnabled } from '../../../../config/index.js';
import { hopFenceRef } from '../land/fence.js';
import { hopFenceObject } from '../land/fence.js';
import { hopFenceRefusal } from '../land/fence.js';
import { hopFenceLeaseFrom } from '../land/fence.js';
import { carryLandingHops } from '../land/fence.js';
import { requireCarriedHops } from '../land/fence.js';

const fs = fileSystemAdapter();

/** Name the remote a landing pushes the trunk to: the trunk branch's own remote, else origin [B3]. */
function landingRemoteName(root, branch) {
  return tryGit(root, ['config', '--get', `branch.${branch.replace(/^refs\/heads\//u, '')}.remote`]).stdout || 'origin';
}

/**
 * Name the configured remote a landing would push the trunk to, or null when this repo has none [B3].
 * An accept uses it to say which landing command fits this repo; the landing itself refuses on null.
 */
export function landingRemote(root, branch) {
  // The board's trunk remote setting wins, so the lander pushes where runners fetch, whatever host it runs on [P7].
  const configured = trunkRemote(root);
  if (configured) return configured;
  const remote = landingRemoteName(root, branch);
  return tryGit(root, ['remote', 'get-url', remote]).status === 0 ? remote : null;
}

/** Build the one LAND_PUSH refusal every landing push failure reports, real or previewed [B3]. */
function pushRefused(reason, next = 'inspect the remote and hooks, then run pullboard land --adopt') {
  return new Refused('LAND_PUSH', `the landing push failed: ${reason}; ${next}`);
}

/**
 * Start comparisons for the previous main's named red files after publication in a detached child, so the landing
 * worker exits the moment it has landed. Why: run in this process, a 9-minute comparison kept the worker alive and the
 * scheduler held the next batch behind it on 6 Nov; the child logs to automatic-landing/main-red-refresh.log [C7].
 */
export function refreshPublishedMainReds(state, previousMain, { launch = spawnDetachedRefresh } = {}) {
  const publishedMain = mainCheckout(state.root)?.commit;
  if (!publishedMain || publishedMain === previousMain) return null;
  try { launch(state.root, previousMain, publishedMain); }
  catch (error) { state.say(`background main-red refresh could not start: ${String(error?.message ?? error).slice(0, 180)}`); return null; }
  return { previousMain, publishedMain };
}

/**
 * At batch start, refresh the main-red cache for a base that has none, from the newest cached generation, in a detached
 * child; returns the record to keep on the batch, or null when nothing starts. Why: a hand-moved main had no generation, so
 * the batch's red split re-measured known reds on runners for 18 minutes [C7,#3268].
 */
export function startBaseRefresh(state, batch, { source = refreshSource, launch = spawnDetachedRefresh } = {}) {
  if (batch.refreshStarted) return null;
  try {
    const previous = source(state.root, batch.base);
    if (!previous) return null;
    launch(state.root, previous, batch.base);
    return { previous, published: batch.base };
  } catch (error) { state.say?.(`base main-red refresh could not start: ${String(error?.message ?? error).slice(0, 180)}`); return null; }
}

/**
 * The environment a refresh runs in: this one without a checkout lease token or agent session id, so the refresh and
 * anything it starts never act under, or queue for, a checkout's lease. Why: a refresh is a read plus a cache write, and
 * a refresh started by a write command inherited that command's checkout authority [C7].
 */
export function refreshEnvironment(env = environmentAdapter().all()) {
  const clean = { ...env };
  for (const name of ['PULLBOARD_CHECKOUT_SESSION_TOKEN', ...AGENT_SESSION_IDS]) delete clean[name];
  return clean;
}

/**
 * The detached refresh child: its own process group, no inherited stdio, never awaited. It starts only when no refresh
 * runs on this machine and none started within the spacing window, so landings never pile refreshes up (9 Nov) [C7].
 * Returns whether a child started.
 */
export function spawnDetachedRefresh(root, previousMain, publishedMain, { claim = claimRefreshStart } = {}) {
  if (!claim()) return false;
  const child = spawn(process.execPath, [fileURLToPath(new URL('../main/red/refresh.js', import.meta.url)), root, previousMain, publishedMain],
    { cwd: root, detached: true, stdio: 'ignore', env: refreshEnvironment() });
  child.unref();
  return true;
}

/**
 * Return the remote a landing pushes to, refusing LAND_PUSH when it does not exist [B3].
 * The dry run and the real landing both call this, so a preview cannot say "would land" for a push that must fail.
 */
export function requirePushTarget(root, branch) {
  const remote = landingRemote(root, branch);
  if (remote) return remote;
  const missing = landingRemoteName(root, branch);
  throw pushRefused(`this repo has no ${missing} remote to push ${branch.replace(/^refs\/heads\//u, '')} to`,
    `add one with git remote add ${missing} <url> and run pullboard land again, or merge each verified commit on the trunk with git merge --no-ff and record it with pullboard merged <id> <commit>`);
}

/** Recheck immutable publication inputs after the last awaited canonical operation. */
function publicationInputs(state, batch) {
  requireLandingCarries(state, batch);
  requireLandingCompanions(batch.root, state.board, batch.items, batch.tip);
  state.landingPorts.validateQuarantineLandingProof(state.board, batch);
  for (const entry of batch.items) {
    const item = store.getItem(state.board, entry.id);
    requireOutsideOwner(state.board, item);
    // A hold placed after the batch merged still stops it here, before any receipt or trunk move [C7].
    if (item.item_hold_at) throw new Refused('ITEM_HELD', `item #${entry.id} is held by coordinator: ${item.item_hold_reason ?? 'held'}; lift it with pullboard hold ${entry.id} --off, then land again`);
    if (batch.external) continue;
    if (item.item_status !== 'verified' || item.item_commit !== entry.commit
      || store.checkedLandingCommit(state.board, item) !== (entry.reviewedCommit ?? entry.commit)) {
      throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} changed its checked composition; rebuild the landing before publishing`);
    }
  }
  if (batch.proof?.failures?.some(failure => !nativeLandingWaiverFor(state.board, failure, state.landingPorts))) throw new Refused('LAND_WAIVER', 'the landing proof has an expired or missing person waiver; ask the person for a new expiring waiver, then adopt the batch');
  if (headCommit(batch.root) !== batch.tip || !isClean(batch.root) || untracked(batch.root).length) throw new Refused('LAND_MOVED', 'the gated landing tree changed; inspect the batch and adopt it again');
  if (mainCheckout(state.root)?.commit !== batch.base) throw new Refused('LAND_TRUNK_MOVED', 'main moved during the landing; rebuild the batch from its new tip');
}

/** Push from the actual gate-owning worktree, preserving its native stamp and canonical batch root. */
function parallelPublicationRoot(state, batch) {
  const root = state.config.landing?.requireReceipts === true ? batch.root : batch.parallelProofRoot ?? batch.root;
  if (root === batch.root) return root;
  const owner = (batch.parallelCandidates ?? []).some(candidate => candidate.snapshot.root === root
    && (candidate.gate?.tree === batch.proof?.tree || candidate.snapshot.gateResults?.some(gate => gate.tree === batch.proof?.tree && gate.logPath === batch.proof?.logPath)));
  if (!owner || !fs.exists(root) || !sameCommonDir(fs.realpath(repoInfo(root).commonDir), fs.realpath(repoInfo(batch.root).commonDir))) {
    throw new Refused('LAND_MOVED', 'the recorded gate-owning worktree is missing or belongs to another repository; restore it before adopting');
  }
  const tree = git(state.root, ['rev-parse', `${batch.tip}^{tree}`]);
  if (batch.proof?.tree !== tree || headTree(root) !== tree || headTree(batch.root) !== tree || !isClean(root) || untracked(root).length) {
    throw new Refused('LAND_MOVED', 'the speculative proof no longer matches both clean landing trees; restore the exact recorded composition before adopting');
  }
  // Existing native stamps prove trees. A duplicate composition may have different merge metadata;
  // checking out its identical tree preserves that contract without creating or copying any stamp.
  state.checkLeaseNow();
  if (headCommit(root) !== batch.tip) git(root, ['checkout', '--detach', batch.tip]);
  const computed = quarantineBatchGates(batch).find(gate => gate.tree === batch.proof?.tree && gate.logPath === batch.proof?.logPath && gate.blockingVerdict?.green === true);
  if (computed) state.landingPorts.validateQuarantineGate(state.board, computed);
  if (!(batch.proof.failures ?? []).length && !batch.proof.knownMain?.length && !computed && !isStampedGreen(root)) {
    throw new Refused('LAND_MOVED', 'the gate-owning worktree lost its native green stamp; inspect the recorded gate before adopting');
  }
  return root;
}

/**
 * Read the flake ratchet and refuse with FLAKE_RATCHET when it is not allowed; writes nothing.
 * Why: the landing asks before its gate starts so a refusal never spends a gate, and again at publish [C7].
 */
export function checkFlakeRatchet(state) {
  const result = state.landingPorts.landingFlakeRatchet(state.board);
  if (!result.allowed) {
    const names = [...result.unprotected, ...result.malformed, ...result.unjustified]
      .map(row => `${row.file} :: ${row.name}`);
    throw new Refused('FLAKE_RATCHET', `landing would raise or leave an unquarantined flaky test: ${[...new Set(names)].join(', ')}`,
      'quarantine each newly observed flake with a filed repair item before landing');
  }
  return result;
}

/** Bind the native count to the batch before any trunk or remote publication. */
export async function prepareFlakeLanding(state) {
  // The snapshot carries an event boundary the board checks at write time. Seats write gate runs and flake
  // observations every few seconds, so a boundary read before the write is often stale: recompute and write again
  // rather than sleep on it, which starved a landing for 2 minutes on 6 Nov [C7].
  for (let attempt = 1; ; attempt++) {
    const result = checkFlakeRatchet(state);
    try { return await save(state, { flakeRatchet: result.snapshot }); }
    catch (error) {
      if (error?.code !== 'BOARD_BUSY' || !/flake evidence or repair status changed/u.test(error.message ?? '') || attempt >= 40) throw error;
      state.say?.(`flake ratchet boundary moved under the landing (attempt ${attempt}); recomputing`);
    }
  }
}

/** The finish steps the automatic lander has done before its finish runs: engines in each item merge, the gate, the audits at start, stale verdicts at selection. */
const AUTOMATIC_EARLIER = ['amendLandingEngines', 'gate', 'activateMainAudits', 'returnStaleVerdicts'];

/**
 * With landing.pipeline on, refuse to publish a batch while an earlier-started batch on the same branch is still in flight.
 * Why: two batches gate side by side, but each fast-forwards main from its own base, so the one that started first must land
 * first or the later one's publish moves main under it. Off, nothing changes from the one-at-a-time landing [C7,#8973].
 *
 * @param {{ config: object, board: object }} state
 * @param {{ id: string, branch: string, startedAt?: string }} batch
 * @param {{ batches?: () => object[] }} [options] The recorded batches; the board's by default.
 */
export function requirePublishTurn(state, batch, { batches = () => store.landingBatches(state.board) } = {}) {
  if (state.config?.landing?.pipeline !== true || !Number.isFinite(Date.parse(batch.startedAt ?? ''))) return;
  const started = (other) => Date.parse(other.startedAt ?? '');
  const earlier = batches().filter(other => other.id !== batch.id && other.branch === batch.branch
    && !['landed', 'blocked'].includes(other.state) && Number.isFinite(started(other))
    && (started(other) < started(batch) || started(other) === started(batch) && other.id < batch.id));
  if (earlier.length) throw new Refused('LAND_MOVED', `batch ${earlier[0].id} started before ${batch.id} and is still in flight; the earlier batch publishes first, then adopt this one`);
}

/**
 * With landing.pipeline on, a batch gated on top of an earlier batch that then blocked proved a tree that will never exist:
 * record it blocked, so the lander rebuilds and gates it again on main, and refuse the publish. A batch whose earlier batch
 * landed (or is still in flight) is untouched: it publishes without a second gate. Off, nothing changes [C7,#3155,#8938].
 *
 * @param {{ config: object, board: object, write: Function }} state
 * @param {{ id: string, branch: string, base: string, startedAt?: string, revision?: number }} batch
 * @param {{ batches?: () => object[] }} [options] The recorded batches; the board's by default.
 */
export async function discardOrphanedBatch(state, batch, { batches = () => store.landingBatches(state.board) } = {}) {
  if (state.config?.landing?.pipeline !== true || !Number.isFinite(Date.parse(batch.startedAt ?? ''))) return;
  const parent = batches().find(other => other.id !== batch.id && other.branch === batch.branch && other.state === 'blocked' && other.tip === batch.base);
  if (!parent) return;
  const message = `batch ${parent.id} failed, and ${batch.id} was gated on top of it; ${batch.id} is discarded and gated again on main`;
  await state.write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...batch, state: 'blocked',
    refusal: { code: 'LAND_MAIN_MOVED', message, at: state.board.clock.now().toISOString() } }, revision: batch.revision ?? 0 }]);
  throw new Refused('LAND_MAIN_MOVED', message);
}

/**
 * Push the exact gated tip before recording receipts, then fast-forward only a clean unchanged main.
 *
 * @param {object} state
 * @param {{ batches?: () => object[], finish?: Function }} [options] The recorded batches the publish turn reads, and the finish sequence; the board's and finishLanding by default.
 */
export async function publish(state, { batches, finish = finishLanding } = {}) {
  requirePublishTurn(state, state.batch, batches ? { batches } : undefined);
  await discardOrphanedBatch(state, state.batch, batches ? { batches } : undefined);
  await finalizeLandingEnvelope(state, save, () => landingRunObserver(state, state.config, headCommit(state.batch.root)));
  let batch = state.batch;
  if (!scanRidesRunner(state)) await requireLandingModuleResolution(batch.root, batch.base, batch.tip);
  requireLandingCarries(state, batch);
  const remote = requirePushTarget(state.root, batch.branch);
  if (batch.proof?.failures?.length && batch.state !== 'pushed') {
    const failures = batch.proof.failures.map((failure) => ({ ...failure, waiver: nativeLandingWaiverFor(state.board, failure, state.landingPorts)?.id }));
    if (!failures.every((failure) => failure.waiver)) throw new Refused('LAND_WAIVER', 'the landing proof has an expired or missing person waiver; ask the person for a new expiring waiver, then adopt the batch');
    batch = await save(state, { proof: { ...batch.proof, failures } });
  }
  if (batch.state !== 'pushed') {
    await timedPhase(state.say, 'lease check', () => state.checkLease());
    batch = await prepareFlakeLanding(state);
    publicationInputs(state, batch);
    const pushRoot = parallelPublicationRoot(state, batch);
    const alreadyPushed = tryGit(batch.root, ['ls-remote', remote, batch.branch]).stdout.split(/\s+/u)[0] === batch.tip;
    if (!alreadyPushed) batch = await pushCarryingHops(state, batch, { pushRoot, remote, enabled: fencedHopEnabled() });
    await save(state, { state: 'pushed' });
  }
  if (tryGit(batch.root, ['ls-remote', remote, batch.branch]).stdout.split(/\s+/u)[0] !== batch.tip) {
    throw new Refused('LAND_REMOTE_MOVED', 'the remote no longer names the pushed batch tip; inspect it before adopting, without rewriting the remote');
  }
  state.batch = state.config.landing?.requireReceipts === true
    ? await state.write('recordTrainLanding', [prepareNativeTrainLanding(state.batch.root, state.board, state.batch.id, state.batch.proof?.receipt?.id)])
    : await state.write('finishLandingBatch', [{ agentId: 'coordinator', id: state.batch.id, tip: state.batch.tip, ...exactTreeArgument(state) }]);
  await state.checkLease();
  const main = mainCheckout(state.root);
  await finish(state, { earlier: AUTOMATIC_EARLIER, steps: { moveMain: () => { if (main?.commit === state.batch.base && isClean(state.root) && !untracked(state.root).length) git(state.root, ['merge', '--ff-only', state.batch.tip]); }, refreshMainReds: () => refreshPublishedMainReds(state, batch.base) } });
  state.say(`landed ${state.batch.items.map((entry) => `#${entry.id}`).join(', ')} at ${state.batch.tip}`);
  return state.batch;
}

/**
 * Publish's trunk push: with gate.fencedHop on (`enabled`) it first saves each item's hop epoch on the batch, then checks the lease and pushes through the fences.
 * Why save before the push: a resumed batch must carry the epochs it pushed under, never re-read ones a newer owner wrote; a batch that already carries hops keeps them [C7,#8320,#8326].
 *
 * @param {{ board: { db: import('node:sqlite').DatabaseSync }, write: Function, checkLeaseNow: Function, say?: Function, batch: object }} state
 * @param {{ items: { id: number }[], branch: string, base: string, hops?: { item: number, epoch: number }[] }} batch
 * @param {{ pushRoot: string, remote: string, enabled: boolean }} options
 * @returns {Promise<object>} The batch as saved.
 */
export async function pushCarryingHops(state, batch, { pushRoot, remote, enabled }) {
  if (enabled && !batch.hops) batch = await save(state, { hops: carryLandingHops(state.board.db, batch.items, { enabled }) });
  await timedPhase(state.say, 'lease check', () => state.checkLeaseNow());
  const pushed = await timedPhase(state.say, 'push', () => pushLandingTrunk(pushRoot, state.board.db, { remote, branch: batch.branch, base: batch.base, enabled, hops: batch.hops ?? [], step: { board: state.board, headItem: batch.items[0]?.id } }));
  if (pushed.status !== 0) throw pushRefused(pushed.stderr || pushed.stdout);
  return batch;
}

/**
 * Point the remote's hop fence ref at this epoch, only from the epoch before it, so a new hop owner shuts out the one it replaced [C7,#8275].
 * The hop row's compare-and-set gave this owner the epoch; the fence carries it to the remote trunk lives on. Fencing the epoch the ref already holds is a no-op.
 */
export function fenceHop(root, { remote, item, epoch, step }) {
  const ref = hopFenceRef(item);
  const next = hopFenceObject(root, { item, epoch });
  const holds = tryGit(root, ['ls-remote', remote, ref]).stdout.split(/\s+/u)[0];
  if (holds === next) return next;
  // The fence may move only from nothing or an earlier epoch; a later epoch means this owner is stale [C7,#8320].
  const from = hopFenceLeaseFrom(root, { item, epoch }, holds);
  if (from === null) throw hopFenceRefusal(root, { remote, item, epoch, step }, { status: 1, stdout: '', stderr: 'rejected: the fence holds a later epoch' });
  // No '+' on the refspec: a forced refspec skips the lease, and the lease is the fence.
  const pushed = tryGit(root, ['push', '--atomic', '--quiet', `--force-with-lease=${ref}:${from}`, remote, `${next}:${ref}`]);
  if (pushed.status !== 0) throw hopFenceRefusal(root, { remote, item, epoch, step }, pushed);
  return next;
}

/**
 * The leases and refspecs that move each item's fence ref to its carried epoch in the same atomic push as trunk, and a check that names a fence a failed push lost.
 * Each fence moves only from nothing or an earlier epoch of its item; a fence already at a later epoch is refused HOP_FENCED before anything is pushed.
 * Why one push: the runner land job has no board row to re-read, so trunk and every fence move together or not at all [C7,#8437].
 *
 * @param {string} root
 * @param {string} remote
 * @param {{ item: number, epoch: number }[]} hops
 * @returns {{ leases: string[], refspecs: string[], requireHeld: (pushed: { status: number, stdout: string, stderr: string }) => void }}
 */
export function hopFencePush(root, remote, hops, step) {
  const fences = hops.map(hop => {
    const ref = hopFenceRef(hop.item), next = hopFenceObject(root, hop);
    const holds = tryGit(root, ['ls-remote', remote, ref]).stdout.split(/\s+/u)[0];
    const from = holds === next ? next : hopFenceLeaseFrom(root, hop, holds);
    if (from === null) throw hopFenceRefusal(root, { remote, ...hop, step }, { status: 1, stdout: '', stderr: 'rejected: the fence holds a later epoch' });
    return { hop, ref, next, from };
  });
  const requireHeld = pushed => {
    if (pushed.status === 0) return;
    const lost = fences.find(({ hop, ref, next, from }) => {
      const holds = tryGit(root, ['ls-remote', remote, ref]).stdout.split(/\s+/u)[0];
      return holds !== next && holds !== from && hopFenceLeaseFrom(root, hop, holds) === null;
    });
    if (lost) throw hopFenceRefusal(root, { remote, ...lost.hop, step }, pushed);
  };
  return { leases: fences.map(({ ref, from }) => `--force-with-lease=${ref}:${from}`), refspecs: fences.map(({ ref, next }) => `${next}:${ref}`), requireHeld };
}

/**
 * Push trunk from the batch base to its tip in one atomic push that also checks the hop fence ref still holds this hop's epoch.
 * Why atomic with two leases: a stale owner's push must leave trunk exactly where it was, so the fence and trunk move together or not at all [C7,#8275].
 * With no hop (gate.fencedHop off) it is the plain push the landing has always made.
 *
 * @param {string} root - The checkout whose HEAD (or `tip`) is pushed.
 * @param {{ remote: string, branch: string, base: string, tip?: string, hop?: { item: number, epoch: number } }} options
 */
export function pushTrunkThroughFence(root, { remote, branch, base, tip = 'HEAD', hop, hops = hop ? [hop] : [], step }) {
  if (!hops.length) return tryGit(root, ['push', remote, `${tip}:${branch}`]);
  const fences = hops.map(each => ({ hop: each, ref: hopFenceRef(each.item), fence: hopFenceObject(root, each) }));
  const pushed = tryGit(root, ['push', '--atomic', ...fences.map(({ ref, fence }) => `--force-with-lease=${ref}:${fence}`), `--force-with-lease=${branch}:${base}`,
    remote, ...fences.map(({ ref, fence }) => `${fence}:${ref}`), `${tip}:${branch}`]);
  const lost = pushed.status === 0 ? null : fences.find(({ ref, fence }) => tryGit(root, ['ls-remote', remote, ref]).stdout.split(/\s+/u)[0] !== fence);
  if (lost) throw hopFenceRefusal(root, { remote, ...lost.hop, step }, pushed);
  return pushed;
}

/**
 * The landing's trunk push. With gate.fencedHop on (`enabled`) it first checks each carried epoch is still its gate row's, moves
 * each item's fence to that epoch, then pushes trunk and every fence in one atomic push; off, it is the plain push [C7,#8320].
 * Why both the row and the fence: the row refuses an owner already replaced, and the fence refuses one replaced between that read and the push.
 *
 * @param {string} root
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ remote: string, branch: string, base: string, tip?: string, enabled: boolean, hops: { item: number, epoch: number }[] }} options
 */
export function pushLandingTrunk(root, db, { remote, branch, base, tip = 'HEAD', enabled, hops, step }) {
  if (enabled !== true) return pushTrunkThroughFence(root, { remote, branch, base, tip });
  requireCarriedHops(db, hops);
  for (const hop of hops) fenceHop(root, { remote, ...hop, step });
  return pushTrunkThroughFence(root, { remote, branch, base, tip, hops, step });
}

/** Whether this project lands in two tiers: on the local trunk at once, and on the remote only through publish (#801). */
export function landsOnTrunk(config) {
  return config?.landing?.publish === 'separate';
}

/** Reject forged or stale canonical carries even when resuming an already-gated batch. */
function requireLandingCarries(state, batch) {
  if (batch.external) return; // A named landing's commits were proven elsewhere; no verdict carries to check [C7,#5559].
  for (const entry of batch.items) {
    const problem = mergeOnlyLandingProblem(state.root, state.board, store.getItem(state.board, entry.id), { acceptedVerdict: store.acceptedVerdict });
    if (problem) throw problem;
  }
}

/**
 * Move the trunk ref from the batch base to its tip with a compare-and-swap, then bring the primary checkout's index and tracked files along [C7].
 * Why: a merge guarded on a clean tree skipped silently when a stray file sat in the checkout while the log claimed success, so five landed items never reached main.
 * The ref moves whatever the working tree holds; untracked files are left alone; a ref that is no longer at the base records the batch blocked and refuses aloud.
 */
export async function moveTrunkRef(state) {
  const { base, tip } = state.batch;
  const branch = (mainCheckout(state.root)?.branch ?? 'main').replace(/^refs\/heads\//u, '');
  const ref = `refs/heads/${branch}`;
  const current = tryGit(state.root, ['rev-parse', '--verify', '-q', ref]).stdout.trim();
  if (current === tip) {
    state.say?.(`finish: ${branch} already at ${tip}; refreshing the code map`);
    return;
  }
  const swapped = tryGit(state.root, ['update-ref', ref, tip, base]);
  if (swapped.status !== 0) {
    const found = tryGit(state.root, ['rev-parse', '--verify', '-q', ref]).stdout.trim() || 'missing';
    const message = `${branch} is at ${found}, no longer the batch base ${base}; the batch tip ${tip} did not land on it, so rebuild the batch on the new ${branch}`;
    await state.write('recordLandingBatch', [{ agentId: 'coordinator', batch: { ...state.batch, state: 'blocked',
      refusal: { code: 'LAND_MAIN_MOVED', message, at: state.board.clock.now().toISOString() } }, revision: state.batch.revision ?? 0 }]);
    state.say?.(`finish: ${ref} not moved: ${message}`);
    throw new Refused('LAND_MAIN_MOVED', message);
  }
  const head = tryGit(state.root, ['symbolic-ref', '-q', 'HEAD']).stdout.trim();
  if (head !== ref) {
    state.say?.(`finish: ${ref} moved from ${base} to ${tip}; the primary checkout is on another branch, so its files stay as they are; refreshing the code map`);
    return;
  }
  const tree = tryGit(state.root, ['read-tree', '-m', '-u', base, tip]);
  state.say?.(tree.status === 0
    ? `finish: ${ref} moved from ${base} to ${tip}; tracked files updated, untracked files untouched; refreshing the code map`
    : `finish: ${ref} moved from ${base} to ${tip}; the primary checkout's tracked files did not follow (${(tree.stderr || tree.stdout).trim().split('\n')[0]}); run git reset --keep ${tip} there; refreshing the code map`);
}

/** What a red Sprint proof says about the file it reran once: the file, the rerun and main's receipt for it, or that main has none [V37]. */
function redFileDetail(proof) {
  if (!proof.file) return '';
  const receipt = proof.mainReceipt;
  const main = receipt ? `main's receipt for it is ${receipt.result}${receipt.main ? ` at ${String(receipt.main).slice(0, 12)}` : ''}` : 'main has no receipt for it';
  return ` (file ${proof.file} was ${proof.rerun === 'red' ? 'red again on its rerun' : 'green on its rerun'}; ${main})`;
}

/**
 * Whether the item a landing re-proof red reopens keeps its accepted verdict: kept unless main at the batch base changed a file the review covered [C7,U159,#10777].
 * Why: the red is the tree's fault, not the review's; a verdict read that fails never blocks the reopen, it just keeps nothing.
 */
function reopenedVerdict(state, id) {
  try {
    const reads = state.verdictReads ?? { events: store.events, acceptedVerdict: store.acceptedVerdict, verdictReviewProblem: store.verdictReviewProblem, getItem: store.getItem };
    const projector = verdictProjector(state.root, state.board, { main: state.batch.base },
      { events: reads.events, acceptedVerdict: reads.acceptedVerdict, verdictReviewProblem: reads.verdictReviewProblem, trunkRef: reads.trunkRef });
    return projector.reopened(reads.getItem(state.board, id), { composedEquality: state.config.landing?.composedEquality === true });
  } catch { return { keep: false }; }
}

/**
 * Prove the batch's exact tree at Sprint depth before main moves: static checks, then the tests of each cell the batch changes [V37].
 * The record lands on the batch as exactTree.pin, .cells and .result beside exactTree.tree. A red leaves main where it was, records
 * the batch blocked with the failing cell named, and refuses LAND_EXACT_RED.
 * Why before the finish write: a red tree must never get a main-moved receipt, and a green record must name the tree that lands.
 *
 * @param {object} state The landing state.
 * @param {object} [ports] What the proof reads and runs; the batch's own checkout by default.
 * @returns {Promise<object>} The exact-tree record as saved.
 */
export async function requireSprintProof(state, ports = state.sprintPorts ?? sprintPorts(state)) {
  const recorded = exactTreeRecord(state.batch.root, state.batch.tip, state.batch.exactTree);
  const tree = recorded?.tree;
  // An adopted batch keeps the green proof it already holds for this tree; with landing.sprintBarTests on, that proof must carry its bar-test record [U147].
  if (recorded?.result === 'green' && (state.config.landing?.sprintBarTests !== true || recorded.barTests)) return recorded;
  // With landing.composedEquality on, a one-item batch whose staged tree equals the proven composition lands with no retest, when the receipt on the batch is green for this same tree id, not only this commit [C7,#10975].
  const receipt = state.batch.proof?.receipt;
  if (state.config.landing?.composedEquality === true && tree && recorded.composedEqual === true && receipt?.tree === tree && receiptBlockingGreen(receipt)) {
    await save(state, { exactTree: { ...recorded, result: 'green', composition: 'same-tree', receipt: receipt.id } });
    return state.batch.exactTree;
  }
  if (!tree) throw new Refused('LAND_EXACT_TREE', `the batch tip ${state.batch.tip} has no readable tree id, so no proof can name the tree main will point to; rebuild the batch`);
  state.say?.(`finish: proving tree ${tree} at Sprint depth before main moves`);
  // exact.js loads only when a landing proves its tree, so commands that never land skip it (closure-budget) [C7].
  const { sprintProof } = await import('../exact.js');
  const proof = await sprintProof({ tree }, ports);
  if (proof.result === 'green') {
    // With landing.composedEquality on, a staged tree that differs from the composition (or a multi-item batch) is re-proved here and the record says so [C7,#10976].
    const reproved = state.config.landing?.composedEquality === true && recorded.composedEqual === false;
    await save(state, { exactTree: reproved ? { ...proof, composition: 're-proved' } : proof });
    return state.batch.exactTree;
  }
  const barFile = proof.barFile ?? proof.file;
  const where = proof.failed === 'bar' ? `the frozen bar tests of item #${proof.item}${barFile ? ` (file ${barFile})` : ''}` : proof.failed;
  const message = `the Sprint proof is red on tree ${tree} in ${where}${proof.barFile ? '' : redFileDetail(proof)}; main was not moved, so fix ${proof.failed === 'static' ? 'the static check' : proof.failed === 'bar' ? `the bar tests of item #${proof.item}` : `the tests of ${proof.failed}`} and resubmit`;
  // With landing.composedEquality on, a red in one item's frozen bar tests sends that item back to its lane naming the file and main-at, and the batch's other items are not blamed [C7,#10776].
  if (state.config.landing?.composedEquality === true && proof.failed === 'bar' && Number.isInteger(proof.item)) {
    const kept = reopenedVerdict(state, proof.item);
    const note = `the re-proved tree is red in the frozen bar tests of this item (file ${barFile ?? 'unknown'}) at main ${String(state.batch.base).slice(0, 12)}; main was not moved; fix that test and resubmit${kept.keep ? '; its accepted review stays bound, since main changed no file the review covered' : kept.stale?.file ? `; its review is stale, since main changed ${JSON.stringify(kept.stale.file)}, so another agent re-reviews it` : ''}`;
    await state.write('reopen', [proof.item, { agentId: 'coordinator', note }]);
    await save(state, { exactTree: proof, state: 'blocked', failures: [{ file: barFile ?? null, name: note }], refusal: { code: 'LAND_REPROVE_RED', message: `item #${proof.item} reopened: ${note}`, at: state.board.clock.now().toISOString() } });
    state.say?.(`finish: item #${proof.item} reopened to its lane: ${note}`);
    throw new Refused('LAND_REPROVE_RED', `item #${proof.item} reopened: ${note}`);
  }
  await save(state, { exactTree: proof, state: 'blocked', failures: [{ file: null, name: message }], refusal: { code: 'LAND_EXACT_RED', message, at: state.board.clock.now().toISOString() } });
  state.say?.(`finish: ${message}`);
  throw new Refused('LAND_EXACT_RED', message);
}

/** The trunk branch's ref name and its current commit, read the way moveTrunkRef reads them. */
function trunkRefState(state) {
  const branch = (mainCheckout(state.root)?.branch ?? 'main').replace(/^refs\/heads\//u, '');
  const ref = `refs/heads/${branch}`;
  return { branch, ref, current: tryGit(state.root, ['rev-parse', '--verify', '-q', ref]).stdout.trim() };
}

/**
 * The ports of the restage loop for this batch: the same compare moveTrunkRef's update-ref makes, a merge of the staged tip onto the new main, the Sprint proof, and the yield [V35].
 * A restage merges the old tip into the current main in the batch's checkout, so the item merges stay in history and only the new tip is proved;
 * a merge that conflicts is abandoned and refuses LAND_ITEM_MOVED so the batch is rebuilt from current verified work.
 */
function restagePorts(state) {
  const verify = async () => {
    const { branch, current } = trunkRefState(state);
    if (current === state.batch.base || current === state.batch.tip) return;
    throw new Refused('LAND_MAIN_MOVED', `${branch} is at ${current || 'missing'}, no longer the batch base ${state.batch.base}; restaging the batch on it`);
  };
  const restage = async () => {
    const { current: main } = trunkRefState(state);
    const { root, tip, id } = state.batch;
    const who = ['-c', `user.name=${tryGit(root, ['config', 'user.name']).stdout.trim() || 'pullboard'}`, '-c', `user.email=${tryGit(root, ['config', 'user.email']).stdout.trim() || 'pullboard@localhost'}`];
    git(root, ['checkout', '--detach', '--quiet', main]);
    const merged = tryGit(root, [...who, 'merge', '--no-ff', '--no-edit', '-m', `chore(merge): restage batch ${id} on ${main.slice(0, 12)} [C7]`, tip]);
    if (merged.status !== 0) {
      tryGit(root, ['merge', '--abort']);
      git(root, ['checkout', '--detach', '--quiet', tip]);
      throw new Refused('LAND_ITEM_MOVED', `main moved to ${main.slice(0, 12)} and the batch does not merge onto it cleanly; rebuild the batch from current verified work: pullboard land`);
    }
    await save(state, { base: main, tip: headCommit(root) });
    state.say?.(`finish: main moved to ${main.slice(0, 12)}; restaged the batch on it at ${state.batch.tip}`);
  };
  const yieldTurn = async restages => {
    const message = `main moved ${restages + 1} times while batch ${state.batch.id} was staged; its items yield their turn and land behind the others`;
    await save(state, { state: 'blocked', yielded: { restages, at: state.board.clock.now().toISOString() },
      refusal: { code: 'LAND_YIELDED', message, at: state.board.clock.now().toISOString() } });
    for (const entry of state.batch.items) while (store.stepAsideCount(state.board, entry.id) < 2) store.countLeaseLapse(state.board, entry.id);
    state.say?.(`finish: ${message}`);
  };
  return { verify, restage, prove: () => requireSprintProof(state), yieldTurn };
}

/**
 * Stage, prove, then check the move is still a compare-and-set from the base the batch was staged on, restaging up to RESTAGE_LIMIT times; a batch that keeps losing yields and refuses LAND_YIELDED [V35].
 * Why before the receipts: the store records the landing before the ref moves, so a restage after that would leave receipts naming a tip that never lands.
 */
export async function settleOnMain(state, ports = state.restagePorts ?? restagePorts(state)) {
  const { stageUntilCurrent } = await import('../exact.js');
  const settled = await stageUntilCurrent(ports);
  if (settled.yielded) throw new Refused('LAND_YIELDED', state.batch.refusal.message);
  return settled;
}

/** The exact-tree check as an argument of the finish write: only an exact `true` setting adds it, so a move recorded with the setting off replays unchanged [V36]. */
function exactTreeArgument(state) { return state.config.landing?.exactTreeCheck === true ? { exactTreeCheck: true } : {}; }

/** Record a tier-1 batch's merged receipts and move the local trunk to it; an adopted 'trunk' batch resumes here (#801). */
export function finishTrunk(state) {
  return landingSpan('record', () => finishTrunkSteps(state));
}

/** The steps of finishTrunk, timed as one landing span. */
async function finishTrunkSteps(state) {
  await finalizeLandingEnvelope(state, save, () => landingRunObserver(state, state.config, headCommit(state.batch.root)));
  await timedPhase(state.say, 'lease check', () => state.checkLease());
  state.say?.('finish: envelope recorded; checking module resolution');
  if (!scanRidesRunner(state)) await requireLandingModuleResolution(state.batch.root, state.batch.base, state.batch.tip);
  publicationInputs(state, state.batch);
  state.say?.('finish: module resolution checked; proving the exact tree');
  await requireSprintProof(state);
  await settleOnMain(state);
  state.batch = state.config.landing?.requireReceipts === true
    ? await state.write('recordTrainLanding', [prepareNativeTrainLanding(state.batch.root, state.board, state.batch.id, state.batch.proof?.receipt?.id)])
    : await state.write('finishLandingBatch', [{ agentId: 'coordinator', id: state.batch.id, tip: state.batch.tip, ...exactTreeArgument(state) }]);
  await state.checkLease();
  await finishLanding(state, { earlier: AUTOMATIC_EARLIER, steps: { moveMain: () => timedPhase(state.say, 'push', () => moveTrunkRef(state)) } });
  state.say(`landed ${state.batch.items.map((entry) => `#${entry.id}`).join(', ')} at ${state.batch.tip} on the local trunk; pullboard publish pushes it once the whole suite passes`);
}
