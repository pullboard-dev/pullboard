/**
 * The pre-push full gate as pull shard jobs: the gate's tracked test files split by recorded weight, heaviest first
 * (planLandingShards), each shard the whole gate command over its own files (valueGateCommand), offered as a gate-shard
 * job with no item that any free runner pulls. The hook waits until the last shard posts and is red when any shard is.
 *
 * Why: the pre-push gate ran all 2,367 files as one command on one runner, about 3 hours; the submit gate's pull shards
 * already spread a proof over every runner, but only from an item's gate job [C7,#7743].
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { gateRunnerWaitMs } from '../../../../../packages/config/index.js';
import { loadMachineSettings } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { git } from '../../../../../packages/git/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { isClean } from '../../../../../packages/git/index.js';
import { trunkRef } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { untracked } from '../../../../../packages/git/index.js';
import { withBoard } from '../context.js';
import { withBoardRead } from '../context.js';

/** Budget: about this much recorded file time per shard, so one shard stays well inside the runner's 20-minute job ceiling. */
export const PUSH_SHARD_TARGET_MS = 10 * 60_000;
/** Budget: at most this many shard jobs for one push, the board's own cap on one proof's shards. */
const MAX_PUSH_SHARDS = 32;
/** Budget: a shard a runner holds must post within the 20-minute per-job ceiling (packages/runners RUN_CEILING_MS). */
const SHARD_CEILING_MS = 20 * 60_000;
/** Budget: the waiting hook reads its shard rows once a second, one small local read. */
const POLL_MS = 1_000;

/**
 * How many shards a push gate's files make: one per registered runner at least, more when their recorded time needs it to
 * keep each shard near PUSH_SHARD_TARGET_MS, never fewer than two nor more than MAX_PUSH_SHARDS.
 *
 * @param {string[]} files
 * @param {Record<string, number>} times - Last wall time in ms by repository-relative path (a leading ./ is ignored).
 * @param {number} runners - The registered runners.
 * @returns {number}
 */
export function pushShardCount(files, times, runners) {
  const time = file => times[file.replace(/^\.\//u, '')];
  const known = files.map(time).filter(ms => Number.isFinite(ms));
  const average = known.length ? known.reduce((sum, ms) => sum + ms, 0) / known.length : 0;
  const total = files.reduce((sum, file) => sum + (Number.isFinite(time(file)) ? time(file) : average), 0);
  return Math.min(MAX_PUSH_SHARDS, files.length, Math.max(2, runners, Math.ceil(total / PUSH_SHARD_TARGET_MS)));
}

/**
 * The push gate's shard plan, or null when it keeps the one-command gate: dispatch is not pull, the checkout has
 * uncommitted work (a runner fetches committed source only), the gate's tests are fewer than two files, or the gate
 * command cannot name its test files (valueGateCommand refuses it).
 *
 * @param {string} root
 * @param {{ gate: string }} config
 * @returns {Promise<{ main: string, source: string, shards: { files: string[], command: string }[] } | null>}
 */
export async function pushShardPlan(root, config) {
  if (runnerDispatchMode() !== 'pull' || !isClean(root) || untracked(root).length) return null;
  const { planLandingShards, readFileTimes, trackedDefaultTestFiles, valueGateCommand } = await import('../../../../../packages/gate/index.js');
  const files = trackedDefaultTestFiles(root, process.env);
  if (files.length < 2 || !valueGateCommand(root, config.gate, files)) return null;
  const times = readFileTimes(root);
  const count = pushShardCount(files, times, (loadMachineSettings().runners ?? []).length);
  const shards = planLandingShards(files, count, times, root).map(shard => ({ files: shard.files, command: valueGateCommand(root, config.gate, shard.files) }));
  const source = headCommit(root);
  const trunk = trunkRef(root);
  const main = (trunk && tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${trunk}^{commit}`]).stdout.trim()) || source;
  return { main, source, shards };
}

/**
 * Pin the pushed commit under refs/pullboard/push and offer one gate-shard job per shard, with no item. Why a ref: the
 * trunk remote serves only reachable commits, and a pushed commit is reachable from nothing a runner fetches yet.
 *
 * @returns {Promise<{ jobs: string[], ref: string }>}
 */
export async function offerPushShards(ctx, plan) {
  const [{ offerJob, SHARD_JOB_KIND }, { GATE_NEEDS, gateShardRequest }] = await Promise.all([import('../../../../../packages/api/index.js'), import('../submit/pull.js')]);
  const tag = randomBytes(6).toString('hex');
  const ref = `refs/pullboard/push/${tag}`;
  git(ctx.info.root, ['update-ref', ref, plan.source]);
  const of = plan.shards.length;
  const jobs = withBoard(ctx, board => plan.shards.map((shard, at) => offerJob(board.db, { id: `push:${plan.source.slice(0, 12)}:${tag}:shard:${at + 1}`, kind: SHARD_JOB_KIND,
    priority: 'gate', needs: GATE_NEEDS, item: null, candidate: plan.source, base: plan.main,
    request: gateShardRequest({ main: plan.main, source: plan.source, shard: { index: at + 1, of, files: shard.files, command: shard.command } }) }).id));
  // With no registered runners this machine is its own runner, as a pull submit and a pull test run make it [P7,C7].
  const [{ primaryCheckoutRoot }, { ensureLocalRunner }] = await Promise.all([import('../worktree.js'), import('../runner/local.js')]);
  const host = primaryCheckoutRoot(ctx.info);
  if (host) await ensureLocalRunner(host);
  return { jobs, ref };
}

/**
 * Wait until every shard job has posted its receipt. Refuses when no shard changes hands or posts within
 * gate.runnerWaitMs while one still waits for a runner, or when a held shard runs past the 20-minute job ceiling.
 *
 * @returns {Promise<{ job: string, posted: { receipt: object, runner: string | null } }[] | { refused: string }>}
 */
export async function awaitPushShards(ctx, jobs, { say, wait = pause, pollMs = POLL_MS, now = Date.now } = {}) {
  const { jobViews } = await import('../../../../../packages/api/index.js');
  const claimedAt = new Map(), posted = new Map();
  let moved = now();
  while (posted.size < jobs.length) {
    const views = withBoardRead(ctx, board => jobViews(board.db, jobs));
    for (const [at, view] of views.entries()) {
      const job = jobs[at];
      if (!view) return { refused: `shard job ${job} is gone from the board; push again` };
      const receipt = [...view.steps].reverse().find(step => step.name === 'receipt');
      if (receipt && !posted.has(job)) { posted.set(job, receipt.payload); moved = now(); continue; }
      const holder = view.leaseOwner && view.leaseUntil > now() ? `${view.leaseOwner}:${view.attempt ?? 0}` : null;
      if (holder && claimedAt.get(job)?.holder !== holder) {
        claimedAt.set(job, { holder, at: now() });
        moved = now();
        say?.(`pre-push: runner ${view.leaseOwner} took shard job ${job}`);
      }
      if (!posted.has(job) && claimedAt.has(job) && now() - claimedAt.get(job).at > SHARD_CEILING_MS) {
        return { refused: `shard job ${job} ran past the ${SHARD_CEILING_MS / 60_000}-minute job ceiling on runner ${view.leaseOwner ?? 'unknown'}; push again` };
      }
    }
    if (posted.size === jobs.length) break;
    if (jobs.some(job => !posted.has(job) && !claimedAt.has(job)) && now() - moved > gateRunnerWaitMs()) {
      return { refused: `no runner took the waiting shard jobs within ${Math.round(gateRunnerWaitMs() / 1000)}s; start one with pullboard runner serve <board-url>, then push again` };
    }
    await wait(pollMs);
  }
  return jobs.map(job => ({ job, posted: posted.get(job) }));
}

/**
 * The failing files of one red shard: the cases and files its proof named, else every file the shard ran.
 *
 * @param {{ files: string[] }} shard
 * @param {object | undefined} receipt - The shard's posted receipt.
 * @returns {string[]}
 */
export function redShardFiles(shard, receipt) {
  const phase = (receipt?.gate?.phases ?? []).find(row => row.role === 'proof');
  const named = [...(Array.isArray(phase?.failures) ? phase.failures : []), ...(Array.isArray(phase?.errors) ? phase.errors : [])]
    .map(row => row?.file).filter(file => typeof file === 'string' && file);
  const files = [...new Set([...named, ...(Array.isArray(phase?.failedFiles) ? phase.failedFiles : [])].map(file => file.replace(/^\.\//u, '')))];
  return files.length ? files.sort() : shard.files;
}

/**
 * Run the pre-push full gate as pull shard jobs, or return null when pushShardPlan keeps the one-command gate.
 * Green stamps the pushed tree, as a full gate run does, so a retried push of it is not gated twice.
 *
 * @param {object} ctx - The hook's command context.
 * @param {{ say?: (line: string) => void, wait?: Function, pollMs?: number }} [options]
 * @returns {Promise<{ isGreen: boolean, problem: string | null, jobs: string[] } | null>}
 */
export async function pushShardGate(ctx, { say, wait, pollMs } = {}) {
  const root = ctx.info.root;
  const plan = await pushShardPlan(root, ctx.config);
  if (!plan) return null;
  const { jobs, ref } = await offerPushShards(ctx, plan);
  const files = plan.shards.reduce((sum, shard) => sum + shard.files.length, 0);
  say?.(`pre-push: the full gate's ${files} test files are offered as ${jobs.length} shard jobs at ${plan.source.slice(0, 12)}; every free runner pulls them`);
  let settled;
  try { settled = await awaitPushShards(ctx, jobs, { say, wait, pollMs }); }
  finally { try { git(root, ['update-ref', '-d', ref]); } catch { /* a pin left behind only keeps a commit reachable */ } }
  if (!Array.isArray(settled)) return { isGreen: false, problem: `the gate did not finish: ${settled.refused}`, jobs };
  const { combinedReceipt, failingParts } = await import('../../../../../packages/api/index.js');
  const combined = combinedReceipt({ status: 0, gate: { green: true, phases: [] } }, settled);
  if (combined.status === 0) {
    const { stampGreen } = await import('../../../../../packages/gate/index.js');
    stampGreen(root, tryGit(root, ['rev-parse', `${plan.source}^{tree}`]).stdout.trim());
    return { isGreen: true, problem: null, jobs };
  }
  const reds = combined.gate.shards.map((part, at) => ({ ...part, at })).filter(part => !part.green);
  const failing = [...new Set(reds.flatMap(part => redShardFiles(plan.shards[part.at], settled[part.at].posted?.receipt)))].sort();
  return { isGreen: false, jobs, problem: `the gate is red in ${reds.length} of ${jobs.length} shard jobs (${reds.map(part => part.job).join(', ')}); failing files: ${failing.join(', ')}. fix them before pushing.\n${failingParts(combined).join('\n')}` };
}
