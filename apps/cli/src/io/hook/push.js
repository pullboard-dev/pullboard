/**
 * The pre-push full gate as pull shard jobs: the gate's tracked test files split into at most eight partitions balanced by recorded time
 * (planPushShards), each shard the whole gate command over its own files (valueGateCommand), offered as a gate-shard
 * job with no item that any free runner pulls. The hook waits until the last shard posts and is red when any shard is.
 *
 * Why: the pre-push gate ran all 2,367 files as one command on one runner, about 3 hours; the submit gate's pull shards
 * already spread a proof over every runner, but only from an item's gate job [C7,#7743].
 */
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { gateRunnerWaitMs } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { git } from '../../../../../packages/git/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { isClean } from '../../../../../packages/git/index.js';
import { trunkRef } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { untracked } from '../../../../../packages/git/index.js';
import { withBoard } from '../context.js';
import { withBoardRead } from '../context.js';

/** Budget: a shard a runner holds must post within pushGate.shardMinutes, 20 by default like the runner's per-job ceiling (packages/runners RUN_CEILING_MS) [#7810]. */
const DEFAULT_SHARD_MINUTES = 20;
/** Budget: the push gate offers at most this many shards, each a balanced partition of the gate's files by recorded time [C7,#8047]. */
export const PUSH_MAX_SHARDS = 8;
/** Budget: the time assumed for a non-journey test file with no record, about 1.5 times the 6.6 s mean wall per file of the 14 Nov census chunks. */
export const PUSH_DEFAULT_FILE_MS = 10_000;
/** Budget: the time assumed for an apps/<app>/journeys file with no record, about twice the 29.5 s mean wall per journey of the 14 Nov census chunks (near their 90th percentile). */
export const PUSH_DEFAULT_JOURNEY_MS = 60_000;
/** Budget: the waiting hook says its shards are still wanted every 30 s, well inside the 5 minutes after which a claim ends them (PUSH_ALIVE_MS). */
const ALIVE_MS = 30_000;
/** Budget: the waiting hook reads its shard rows once a second, one small local read. */
const POLL_MS = 1_000;

/**
 * How long a push shard may run before the push gate gives up: pushGate.shardMinutes from pullboard.json (default 20), or a
 * raised PULLBOARD_RUNNER_RUN_CEILING_MS when that is longer, so the gate never gives up on a shard its runner still allows.
 * A runner ceiling of 0 (off) or unset adds nothing beyond the setting. Why: the limit was a hard-coded 20 minutes that no
 * setting or runner override could raise [#7810].
 *
 * @param {{ pushGate?: { shardMinutes?: number } } | undefined} config
 * @param {Record<string, string|undefined>} [env]
 * @returns {number} Milliseconds.
 */
export function pushShardLimitMs(config, env = process.env) {
  const minutes = config?.pushGate?.shardMinutes ?? DEFAULT_SHARD_MINUTES;
  const raw = env.PULLBOARD_RUNNER_RUN_CEILING_MS;
  const runner = raw === undefined || raw === '' ? 0 : Number(raw);
  return Math.max(minutes * 60_000, Number.isSafeInteger(runner) && runner > 0 ? runner : 0);
}

/**
 * Split the gate's files into at most PUSH_MAX_SHARDS partitions balanced by recorded time: heaviest file first, each into
 * the lightest partition so far (longest-processing-time first), so partition 1 starts with the heaviest file. A file with
 * no record counts PUSH_DEFAULT_JOURNEY_MS under a journeys folder, else PUSH_DEFAULT_FILE_MS. Every file lands in exactly
 * one partition; two files make two partitions, never fewer. Why a fixed few: a time budget plus a file cap gave dozens of
 * shards on main, each claimed late by a busy runner (#7790); a few balanced partitions keep every runner busy to the end.
 *
 * @param {string[]} files
 * @param {Record<string, number>} times - Last wall time in ms by repository-relative path (a leading ./ is ignored).
 * @param {number} [maxShards]
 * @returns {{ files: string[], weight: number }[]}
 */
export function planPushShards(files, times, maxShards = PUSH_MAX_SHARDS) {
  const weight = file => {
    const path = file.replace(/^\.\//u, '');
    const ms = times[path];
    if (Number.isFinite(ms) && ms >= 0) return ms;
    return /^apps\/[^/]+\/journeys\//u.test(path) ? PUSH_DEFAULT_JOURNEY_MS : PUSH_DEFAULT_FILE_MS;
  };
  const ordered = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  const shards = Array.from({ length: Math.min(Math.max(1, Math.floor(maxShards)), ordered.length) }, () => ({ files: [], weight: 0 }));
  for (const file of ordered) {
    const lightest = shards.reduce((best, shard) => (shard.weight < best.weight ? shard : best));
    lightest.files.push(file);
    lightest.weight += weight(file);
  }
  for (const shard of shards) shard.files.sort((a, b) => a.localeCompare(b));
  return shards.sort((a, b) => b.weight - a.weight || a.files[0].localeCompare(b.files[0]));
}

/**
 * How many shards the push gate should offer, from board data: enough for each to hold about targetMs of recorded time
 * (ceil(totalMs / targetMs)), at least 1, never more than the live runners or PUSH_MAX_SHARDS. Any unknown input (zero,
 * missing or not finite) gives PUSH_MAX_SHARDS, today's fixed plan. Why: shard and runner counts come from measured
 * board data, never typed in (U151); a caller passes them only once it reads them.
 *
 * @param {{ totalMs?: number, runners?: number, targetMs?: number }} data
 * @returns {number}
 */
export function pushShardCount({ totalMs, runners, targetMs } = {}) {
  const known = value => Number.isFinite(value) && value > 0;
  if (!known(totalMs) || !known(runners) || !known(targetMs)) return PUSH_MAX_SHARDS;
  return Math.max(1, Math.min(PUSH_MAX_SHARDS, Math.floor(runners), Math.ceil(totalMs / targetMs)));
}

/**
 * How long the gate waits on one held shard: the pushGate.shardMinutes limit, or the heaviest partition's estimated time
 * when that is longer. Why: with at most eight partitions each holds far more than the old 5-minute shards, so a flat
 * 20-minute limit would give up on a healthy run of main.
 *
 * @param {{ weight: number }[]} shards
 * @param {{ pushGate?: { shardMinutes?: number } } | undefined} config
 * @param {Record<string, string|undefined>} [env]
 * @returns {number} Milliseconds.
 */
export function pushPlanLimitMs(shards, config, env = process.env) {
  return Math.max(pushShardLimitMs(config, env), ...shards.map(shard => shard.weight));
}

/**
 * The push gate's shard plan, or null when it keeps the one-command gate: dispatch is not pull, the checkout has
 * uncommitted work (a runner fetches committed source only), the gate's tests are fewer than two files, or the gate
 * command cannot name its test files (valueGateCommand refuses it).
 *
 * @param {string} root
 * @param {{ gate: string }} config
 * @returns {Promise<{ main: string, source: string, shards: { files: string[], command: string }[], limitMs: number } | null>}
 */
export async function pushShardPlan(root, config) {
  if (runnerDispatchMode() !== 'pull' || !isClean(root) || untracked(root).length) return null;
  const { readFileTimes, trackedDefaultTestFiles, valueGateCommand } = await import('../../../../../packages/gate/index.js');
  const files = trackedDefaultTestFiles(root, process.env);
  if (files.length < 2 || !valueGateCommand(root, config.gate, files)) return null;
  const planned = planPushShards(files, readFileTimes(root));
  const shards = planned.map(shard => ({ files: shard.files, command: valueGateCommand(root, config.gate, shard.files) }));
  const limitMs = pushPlanLimitMs(planned, config);
  const source = headCommit(root);
  const trunk = trunkRef(root);
  const main = (trunk && tryGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${trunk}^{commit}`]).stdout.trim()) || source;
  return { main, source, shards, limitMs };
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
 * gate.runnerWaitMs while one still waits for a runner, or when a held shard runs past pushGate.shardMinutes (or a longer runner ceiling).
 *
 * @returns {Promise<{ job: string, posted: { receipt: object, runner: string | null } }[] | { refused: string }>}
 */
export async function awaitPushShards(ctx, jobs, { say, wait = pause, pollMs = POLL_MS, now = Date.now, read = work => withBoardRead(ctx, work), write = work => withBoard(ctx, work), limitMs = pushShardLimitMs(ctx.config) } = {}) {
  const { jobViews, keepJobsAlive } = await import('../../../../../packages/api/index.js');
  const claimedAt = new Map(), posted = new Map();
  let moved = now(), renewed = -Infinity;
  while (posted.size < jobs.length) {
    // Say the gate is still here, so no claim ends its shards as abandoned (#7805).
    if (now() - renewed >= ALIVE_MS) {
      const open = jobs.filter(job => !posted.has(job));
      write(board => keepJobsAlive(board.db, open, now()));
      renewed = now();
    }
    const views = read(board => jobViews(board.db, jobs));
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
      if (!posted.has(job) && claimedAt.has(job) && now() - claimedAt.get(job).at > limitMs) {
        return { refused: `shard job ${job} ran past the ${Math.round(limitMs / 60_000)}-minute shard limit on runner ${view.leaseOwner ?? 'unknown'}; to allow a longer run, raise pushGate.shardMinutes in pullboard.json (default ${DEFAULT_SHARD_MINUTES}) and PULLBOARD_RUNNER_RUN_CEILING_MS on the runners to match, then push again` };
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
 * Wait for the shard jobs (awaitPushShards) and, however the wait ends, withdraw the ones unfinished: a block, a timeout,
 * a throw, SIGINT or SIGTERM end every shard through the job API, so no runner claims one again [#7805]. `after` runs last.
 *
 * @param {object} ctx
 * @param {string[]} jobs
 * @param {{ say?: Function, wait?: Function, pollMs?: number, now?: () => number, read?: Function, write?: Function, after?: () => void, exit?: (code: number) => never, signals?: { on: Function, off: Function } }} [options]
 * @returns {ReturnType<typeof awaitPushShards>}
 */
export async function awaitAndWithdraw(ctx, jobs, { after = () => {}, exit = process.exit, signals = process, write = work => withBoard(ctx, work), ...options } = {}) {
  const { endJobs } = await import('../../../../../packages/api/index.js');
  const withdraw = () => {
    try { write(board => endJobs(board.db, jobs, { reason: 'the pre-push gate that offered it stopped' })); } catch { /* a shard left over ends itself once its gate stops renewing it */ }
    after();
  };
  const handlers = [['SIGINT', 130], ['SIGTERM', 143]].map(([signal, code]) => [signal, () => { withdraw(); exit(code); }]);
  for (const [signal, handler] of handlers) signals.on(signal, handler);
  try { return await awaitPushShards(ctx, jobs, { ...options, write }); }
  finally { for (const [signal, handler] of handlers) signals.off(signal, handler); withdraw(); }
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
 * The refusal a not-green set of shards makes: red shards name their failing files, and a shard that posted no
 * receipt reads unknown, counted as neither red nor green, so the tree is never stamped green on it [C7,#8046].
 *
 * @param {{ gate: { shards: { job: string, green: boolean }[] } }} combined - combinedReceipt's result.
 * @param {{ posted?: { receipt?: object } }[]} settled - Each shard's awaited result, in plan order.
 * @param {{ shards: { files: string[] }[] }} plan
 * @param {string[]} jobs
 * @param {(receipt: object) => string[]} failingParts
 * @returns {string}
 */
export function shardProblem(combined, settled, plan, jobs, failingParts) {
  const notGreen = combined.gate.shards.map((part, at) => ({ ...part, at })).filter(part => !part.green);
  const unknown = notGreen.filter(part => !settled[part.at].posted?.receipt);
  const reds = notGreen.filter(part => settled[part.at].posted?.receipt);
  const failing = [...new Set(reds.flatMap(part => redShardFiles(plan.shards[part.at], settled[part.at].posted?.receipt)))].sort();
  const redText = reds.length ? `the gate is red in ${reds.length} of ${jobs.length} shard jobs (${reds.map(part => part.job).join(', ')}); failing files: ${failing.join(', ')}. fix them before pushing.\n${failingParts(combined).join('\n')}` : '';
  const unknownText = unknown.length ? `the gate is unknown in ${unknown.length} of ${jobs.length} shard jobs (${unknown.map(part => part.job).join(', ')}): no receipt was posted, so they count as neither red nor green and the tree is not stamped green. push again to rerun them.` : '';
  return [redText, unknownText].filter(Boolean).join('\n');
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
  const settled = await awaitAndWithdraw(ctx, jobs, { say, wait, pollMs, limitMs: plan.limitMs, after: () => { try { git(root, ['update-ref', '-d', ref]); } catch { /* a pin left behind only keeps a commit reachable */ } } });
  if (!Array.isArray(settled)) return { isGreen: false, problem: `the gate did not finish: ${settled.refused}`, jobs };
  const { combinedReceipt, failingParts } = await import('../../../../../packages/api/index.js');
  const combined = combinedReceipt({ status: 0, gate: { green: true, phases: [] } }, settled);
  if (combined.status === 0) {
    const { stampGreen } = await import('../../../../../packages/gate/index.js');
    stampGreen(root, tryGit(root, ['rev-parse', `${plan.source}^{tree}`]).stdout.trim());
    return { isGreen: true, problem: null, jobs };
  }
  return { isGreen: false, jobs, problem: shardProblem(combined, settled, plan, jobs, failingParts) };
}
