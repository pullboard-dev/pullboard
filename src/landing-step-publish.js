/** Coordinator landing publish step; source-preserving partition of land.js [B3,R3,C7]. */
import { finalizeLandingEnvelope } from './land-envelope.js';
import { prepareNativeTrainLanding } from './train-landing.js';
import { refreshLandedCodeMap } from './landing-main-notices.js';
import { mergeOnlyLandingProblem } from './merge-only-verdict.js';
import { requireOutsideOwner } from './outside-source.js';
import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import * as store from './board.js';
import { git } from './git.js';
import { headCommit } from './git.js';
import { headTree } from './git.js';
import { isClean } from './git.js';
import { mainCheckout } from './git.js';
import { repoInfo } from './git.js';
import { tryGit } from './git.js';
import { untracked } from './git.js';
import { isStampedGreen } from './gate.js';
import { Refused } from './refused.js';
import { save } from './landing-step-merge.js';
import { landingRunObserver } from './landing-step-gate.js';

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
  for (const entry of batch.items) {
    const item = store.getItem(state.board, entry.id);
    requireOutsideOwner(state.board, item);
    if (item.item_status !== 'verified' || item.item_commit !== entry.commit
      || store.checkedLandingCommit(state.board, item) !== (entry.reviewedCommit ?? entry.commit)) {
      throw new Refused('LAND_ITEM_MOVED', `item #${entry.id} changed its checked composition; rebuild the landing before publishing`);
    }
  }
  if (batch.proof?.failures?.some(failure => !store.landingWaiverFor(state.board, failure, state.landingPorts))) throw new Refused('LAND_WAIVER', 'the landing proof has an expired or missing person waiver; ask the person for a new expiring waiver, then adopt the batch');
  if (headCommit(batch.root) !== batch.tip || !isClean(batch.root) || untracked(batch.root).length) throw new Refused('LAND_MOVED', 'the gated landing tree changed; inspect the batch and adopt it again');
  if (mainCheckout(state.root)?.commit !== batch.base) throw new Refused('LAND_TRUNK_MOVED', 'main moved during the landing; rebuild the batch from its new tip');
}

/** Push from the actual gate-owning worktree, preserving its native stamp and canonical batch root. */
function parallelPublicationRoot(state, batch) {
  const root = state.config.landing?.requireReceipts === true ? batch.root : batch.parallelProofRoot ?? batch.root;
  if (root === batch.root) return root;
  const owner = (batch.parallelCandidates ?? []).some(candidate => candidate.snapshot.root === root
    && (candidate.gate?.tree === batch.proof?.tree || candidate.snapshot.gateResults?.some(gate => gate.tree === batch.proof?.tree)));
  if (!owner || !existsSync(root) || realpathSync(repoInfo(root).commonDir) !== realpathSync(repoInfo(batch.root).commonDir)) {
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
  if (!(batch.proof.failures ?? []).length && !isStampedGreen(root)) {
    throw new Refused('LAND_MOVED', 'the gate-owning worktree lost its native green stamp; inspect the recorded gate before adopting');
  }
  return root;
}

/** Push the exact gated tip before recording receipts, then fast-forward only a clean unchanged main. */
export async function publish(state) {
  await finalizeLandingEnvelope(state, save, () => landingRunObserver(state, state.config, headCommit(state.batch.root)));
  let batch = state.batch;
  requireLandingCarries(state, batch);
  const remote = requirePushTarget(state.root, batch.branch);
  if (batch.proof?.failures?.length && batch.state !== 'pushed') {
    const failures = batch.proof.failures.map((failure) => ({ ...failure, waiver: store.landingWaiverFor(state.board, failure, state.landingPorts)?.id }));
    if (!failures.every((failure) => failure.waiver)) throw new Refused('LAND_WAIVER', 'the landing proof has an expired or missing person waiver; ask the person for a new expiring waiver, then adopt the batch');
    batch = await save(state, { proof: { ...batch.proof, failures } });
  }
  if (batch.state !== 'pushed') {
    await state.checkLease();
    publicationInputs(state, batch);
    const pushRoot = parallelPublicationRoot(state, batch);
    const alreadyPushed = tryGit(batch.root, ['ls-remote', remote, batch.branch]).stdout.split(/\s+/u)[0] === batch.tip;
    if (!alreadyPushed) {
      state.checkLeaseNow();
      const pushed = tryGit(pushRoot, ['push', remote, `HEAD:${batch.branch}`]);
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
  if (main?.commit === state.batch.base && isClean(state.root) && !untracked(state.root).length) git(state.root, ['merge', '--ff-only', state.batch.tip]);
  await refreshLandedCodeMap(state);
  state.say(`landed ${state.batch.items.map((entry) => `#${entry.id}`).join(', ')} at ${state.batch.tip}`);
  return state.batch;
}

/** Whether this project lands in two tiers: on the local trunk at once, and on the remote only through publish (#801). */
export function landsOnTrunk(config) {
  return config?.landing?.publish === 'separate';
}

/** Reject forged or stale canonical carries even when resuming an already-gated batch. */
function requireLandingCarries(state, batch) {
  for (const entry of batch.items) {
    const problem = mergeOnlyLandingProblem(state.root, state.board, store.getItem(state.board, entry.id), { acceptedVerdict: store.acceptedVerdict });
    if (problem) throw problem;
  }
}

/** Record a tier-1 batch's merged receipts and move the local trunk to it; an adopted 'trunk' batch resumes here (#801). */
export async function finishTrunk(state) {
  await finalizeLandingEnvelope(state, save, () => landingRunObserver(state, state.config, headCommit(state.batch.root)));
  await state.checkLease();
  publicationInputs(state, state.batch);
  state.batch = state.config.landing?.requireReceipts === true
    ? await state.write('recordTrainLanding', [prepareNativeTrainLanding(state.batch.root, state.board, state.batch.id, state.batch.proof?.receipt?.id)])
    : await state.write('finishLandingBatch', [{ agentId: 'coordinator', id: state.batch.id, tip: state.batch.tip }]);
  await state.checkLease();
  const main = mainCheckout(state.root);
  if (main?.commit === state.batch.base && isClean(state.root) && !untracked(state.root).length) git(state.root, ['merge', '--ff-only', state.batch.tip]);
  await refreshLandedCodeMap(state);
  state.say(`landed ${state.batch.items.map((entry) => `#${entry.id}`).join(', ')} at ${state.batch.tip} on the local trunk; pullboard publish pushes it once the whole suite passes`);
}
