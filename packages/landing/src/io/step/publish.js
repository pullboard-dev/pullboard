import { requireLandingCompanions } from '../guards.js';
import { timedPhase } from '../timing.js';
import { requireLandingModuleResolution } from '../guards.js';
import { quarantineBatchGates } from '../../../../verify/index.js';
import { landingWaiverFor as nativeLandingWaiverFor } from '../../logic/waivers.js';
/** Coordinator landing publish step; source-preserving partition of land.js [B3,R3,C7]. */
import { finalizeLandingEnvelope } from '../land/envelope.js';
import { prepareNativeTrainLanding } from '../train.js';
import { finishLanding } from '../finish.js';
import { mergeOnlyLandingProblem } from '../../../../merge/index.js';
import { requireOutsideOwner } from '../../../../items/index.js';
import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
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
import { isStampedGreen } from '../../../../gate/index.js';
import { Refused } from '../../../../kernel/index.js';
import { save } from './merge.js';
import { landingRunObserver } from './gate.js';
import { spawn } from 'node:child_process';
import { refreshSource } from '../main/red.js';
import { fileURLToPath } from 'node:url';
import { landingSpan } from '../../../../resources/index.js';
import { claimRefreshStart } from '../main/red/refresh/flight.js';
import { AGENT_SESSION_IDS } from '../../../../kernel/index.js';
import { scanRidesRunner } from '../scan.js';

/** Name the remote a landing pushes the trunk to: the trunk branch's own remote, else origin [B3]. */
function landingRemoteName(root, branch) {
  return tryGit(root, ['config', '--get', `branch.${branch.replace(/^refs\/heads\//u, '')}.remote`]).stdout || 'origin';
}

/**
 * Name the configured remote a landing would push the trunk to, or null when this repo has none [B3].
 * An accept uses it to say which landing command fits this repo; the landing itself refuses on null.
 */
export function landingRemote(root, branch) {
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
export function refreshEnvironment(env = process.env) {
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
  if (!owner || !existsSync(root) || !sameCommonDir(realpathSync(repoInfo(root).commonDir), realpathSync(repoInfo(batch.root).commonDir))) {
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

/** Push the exact gated tip before recording receipts, then fast-forward only a clean unchanged main. */
export async function publish(state) {
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
    if (!alreadyPushed) {
      await timedPhase(state.say, 'lease check', () => state.checkLeaseNow());
      const pushed = await timedPhase(state.say, 'push', () => tryGit(pushRoot, ['push', remote, `HEAD:${batch.branch}`]));
      if (pushed.status !== 0) throw pushRefused(pushed.stderr || pushed.stdout);
    }
    await save(state, { state: 'pushed' });
  }
  if (tryGit(batch.root, ['ls-remote', remote, batch.branch]).stdout.split(/\s+/u)[0] !== batch.tip) {
    throw new Refused('LAND_REMOTE_MOVED', 'the remote no longer names the pushed batch tip; inspect it before adopting, without rewriting the remote');
  }
  state.batch = state.config.landing?.requireReceipts === true
    ? await state.write('recordTrainLanding', [prepareNativeTrainLanding(state.batch.root, state.board, state.batch.id, state.batch.proof?.receipt?.id)])
    : await state.write('finishLandingBatch', [{ agentId: 'coordinator', id: state.batch.id, tip: state.batch.tip }]);
  await state.checkLease();
  const main = mainCheckout(state.root);
  await finishLanding(state, { earlier: AUTOMATIC_EARLIER, steps: { moveMain: () => { if (main?.commit === state.batch.base && isClean(state.root) && !untracked(state.root).length) git(state.root, ['merge', '--ff-only', state.batch.tip]); }, refreshMainReds: () => refreshPublishedMainReds(state, batch.base) } });
  state.say(`landed ${state.batch.items.map((entry) => `#${entry.id}`).join(', ')} at ${state.batch.tip}`);
  return state.batch;
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
  state.say?.('finish: module resolution checked; recording the finished batch');
  state.batch = state.config.landing?.requireReceipts === true
    ? await state.write('recordTrainLanding', [prepareNativeTrainLanding(state.batch.root, state.board, state.batch.id, state.batch.proof?.receipt?.id)])
    : await state.write('finishLandingBatch', [{ agentId: 'coordinator', id: state.batch.id, tip: state.batch.tip }]);
  await state.checkLease();
  await finishLanding(state, { earlier: AUTOMATIC_EARLIER, steps: { moveMain: () => timedPhase(state.say, 'push', () => moveTrunkRef(state)) } });
  state.say(`landed ${state.batch.items.map((entry) => `#${entry.id}`).join(', ')} at ${state.batch.tip} on the local trunk; pullboard publish pushes it once the whole suite passes`);
}
