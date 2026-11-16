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
import { pushRecordTimingEnabled } from '../../../../../packages/config/index.js';
import { pushRerunFailedShardOnceEnabled } from '../../../../../packages/config/index.js';
import { runnerDispatchMode } from '../../../../../packages/config/index.js';
import { git } from '../../../../../packages/git/index.js';
import { headCommit } from '../../../../../packages/git/index.js';
import { isClean } from '../../../../../packages/git/index.js';
import { trunkRef } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { untracked } from '../../../../../packages/git/index.js';
import { listBoardMetaWithPrefix } from '../../../../../packages/store/index.js';
import { writeBoardMeta } from '../../../../../packages/store/index.js';
import { deleteBoardMeta } from '../../../../../packages/store/index.js';
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
/** Budget: push.recordTiming keeps the newest 20 push.timing rows on the board, one small row each. */
export const PUSH_TIMING_KEPT = 20;
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

/** One file's planned time in ms: its record, else the journey or file default. */
function pushFileWeight(file, times) {
  const path = file.replace(/^\.\//u, '');
  const ms = times[path];
  if (Number.isFinite(ms) && ms >= 0) return ms;
  return /^apps\/[^/]+\/journeys\//u.test(path) ? PUSH_DEFAULT_JOURNEY_MS : PUSH_DEFAULT_FILE_MS;
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
  const weight = file => pushFileWeight(file, times);
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
 * The most shards the push plan may use. With pushGate.sizeFromBoard off (the default) it is PUSH_MAX_SHARDS, as before. With
 * it on, it is pushShardCount over the files' recorded total time, the live runner count the caller read from the board, and
 * a quarter of pushGate.shardMinutes as each shard's target; an unknown runner count keeps PUSH_MAX_SHARDS. Why a quarter:
 * a shard planned to fill the whole limit would be given up on at the first slow run [U151].
 *
 * @param {string[]} files
 * @param {Record<string, number>} times
 * @param {{ pushGate?: { shardMinutes?: number, sizeFromBoard?: boolean } } | undefined} config
 * @param {number} [runners] - Live runners on the board, when the caller read them.
 * @returns {number}
 */
export function pushMaxShards(files, times, config, runners) {
  if (config?.pushGate?.sizeFromBoard !== true) return PUSH_MAX_SHARDS;
  const totalMs = [...new Set(files)].reduce((sum, file) => sum + pushFileWeight(file, times), 0);
  return pushShardCount({ totalMs, runners, targetMs: (config.pushGate.shardMinutes ?? DEFAULT_SHARD_MINUTES) * 60_000 / 4 });
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
 * Why the push gate keeps the one-command gate, in one line, or null when a shard plan exists. A pure function of the facts
 * pushShardPlan tests, one distinct reason per case it answers null for: dispatch is not pull, uncommitted changes,
 * untracked files, fewer than two test files, or a gate command that cannot name its files. Why: the hook fell back to
 * the 3-hour gate without saying so [C7,#9368].
 *
 * @param {{ pull: boolean, clean: boolean, untracked: number, files: number, nameable: boolean }} facts
 * @returns {string | null}
 */
export function pushShardSkipReason({ pull, clean, untracked: loose, files, nameable }) {
  if (!pull) return 'gate.runnerDispatch is not pull, so there are no runners to shard over';
  if (!clean) return 'the checkout has uncommitted changes, and a runner fetches committed source only; commit or stash them';
  if (loose > 0) return 'the checkout has untracked files, and a runner fetches committed source only; commit or remove them';
  if (files < 2) return `the gate has ${files} test file${files === 1 ? '' : 's'}, and sharding needs at least two`;
  if (!nameable) return 'the gate command cannot name its test files, so it cannot be split into shards';
  return null;
}

/** Read the facts pushShardSkipReason takes from the checkout; the same tests pushShardPlan makes, so the reason matches its null. */
async function pushShardFacts(root, config) {
  const pull = runnerDispatchMode() === 'pull', clean = isClean(root), loose = untracked(root).length;
  if (!pull || !clean || loose) return { pull, clean, untracked: loose, files: 0, nameable: true };
  const { trackedDefaultTestFiles, valueGateCommand } = await import('../../../../../packages/gate/index.js');
  const files = trackedDefaultTestFiles(root, process.env);
  return { pull, clean, untracked: loose, files: files.length, nameable: files.length < 2 || Boolean(valueGateCommand(root, config.gate, files)) };
}

/**
 * The push gate's shard plan, or null when it keeps the one-command gate: dispatch is not pull, the checkout has
 * uncommitted work (a runner fetches committed source only), the gate's tests are fewer than two files, or the gate
 * command cannot name its test files (valueGateCommand refuses it).
 *
 * @param {string} root
 * @param {{ gate: string }} config
 * @param {{ runners?: number }} [board] - Live runner count from the board, used only with pushGate.sizeFromBoard on.
 * @returns {Promise<{ main: string, source: string, shards: { files: string[], command: string }[], limitMs: number } | null>}
 */
export async function pushShardPlan(root, config, { runners } = {}) {
  if (runnerDispatchMode() !== 'pull' || !isClean(root) || untracked(root).length) return null;
  const { readFileTimes, trackedDefaultTestFiles, valueGateCommand } = await import('../../../../../packages/gate/index.js');
  const files = trackedDefaultTestFiles(root, process.env);
  if (files.length < 2 || !valueGateCommand(root, config.gate, files)) return null;
  const times = readFileTimes(root);
  const planned = planPushShards(files, times, pushMaxShards(files, times, config, runners));
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
 * @returns {Promise<{ jobs: string[], ref: string, reoffer: (board: { db: object }, job: string, runner: string | null) => string }>}
 */
export async function offerPushShards(ctx, plan) {
  const [{ offerJob, endJobs, SHARD_JOB_KIND }, { GATE_NEEDS, gateShardRequest }] = await Promise.all([import('../../../../../packages/api/index.js'), import('../submit/pull.js')]);
  const tag = randomBytes(6).toString('hex');
  const ref = `refs/pullboard/push/${tag}`;
  git(ctx.info.root, ['update-ref', ref, plan.source]);
  const of = plan.shards.length;
  const offer = (board, at, id, avoid = []) => offerJob(board.db, { id, kind: SHARD_JOB_KIND,
    priority: 'gate', needs: GATE_NEEDS, item: null, candidate: plan.source, base: plan.main, avoid,
    request: gateShardRequest({ main: plan.main, source: plan.source, shard: { index: at + 1, of, files: plan.shards[at].files, command: plan.shards[at].command } }) }).id;
  const jobs = withBoard(ctx, board => plan.shards.map((shard, at) => offer(board, at, `push:${plan.source.slice(0, 12)}:${tag}:shard:${at + 1}`)));
  /** Withdraw a failed shard job and offer the same shard again, naming the runner it failed on to avoid [C7,#9274]. */
  const reoffer = (board, job, runner) => {
    endJobs(board.db, [job], { reason: 'the pre-push gate re-offered this shard once' });
    return offer(board, jobs.indexOf(job), `${job}:again`, runner ? [runner] : []);
  };
  // With no registered runners this machine is its own runner, as a pull submit and a pull test run make it [P7,C7].
  const [{ primaryCheckoutRoot }, { ensureLocalRunner }] = await Promise.all([import('../worktree.js'), import('../runner/local.js')]);
  const host = primaryCheckoutRoot(ctx.info);
  if (host) await ensureLocalRunner(host);
  return { jobs, ref, reoffer };
}

/**
 * Wait until every shard job has posted its receipt. Refuses when no shard changes hands or posts within
 * gate.runnerWaitMs while one still waits for a runner, or when a held shard runs past pushGate.shardMinutes (or a longer runner ceiling).
 * With push.rerunFailedShardOnce on (and a `reoffer`), a shard whose runner lapsed or posted an infrastructure failure is re-offered once, avoiding
 * that runner; the shard's job id in `jobs` becomes the new job's. A `timing` map is filled with each shard's runner and wall time (claim to receipt) as it posts [C7,#9371].
 * A second lapse refuses; a second infrastructure failure posts as it is [C7,#9274].
 *
 * @returns {Promise<{ job: string, posted: { receipt: object, runner: string | null } }[] | { refused: string }>}
 */
export async function awaitPushShards(ctx, jobs, { say, wait = pause, pollMs = POLL_MS, now = Date.now, read = work => withBoardRead(ctx, work), write = work => withBoard(ctx, work), limitMs = pushShardLimitMs(ctx.config), reoffer = null, rerun = pushRerunFailedShardOnceEnabled(), timing = null } = {}) {
  const { jobViews, keepJobsAlive, endJobs } = await import('../../../../../packages/api/index.js');
  const claimedAt = new Map(), posted = new Map(), again = new Set();
  const began = now();
  let moved = began, renewed = -Infinity;
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
      const holder = view.leaseOwner && view.leaseUntil > now() ? `${view.leaseOwner}:${view.attempt ?? 0}` : null;
      const before = claimedAt.get(job)?.holder;
      const infra = Boolean(receipt?.payload?.receipt?.gate?.analysis?.infra ?? receipt?.payload?.gate?.analysis?.infra);
      const lapsed = !receipt && before && (view.leaseOwner && view.leaseUntil <= now() || holder && holder !== before);
      if (rerun && reoffer && !posted.has(job) && (lapsed || infra)) {
        const runner = infra ? (receipt.payload?.runner ?? view.leaseOwner ?? before?.slice(0, before.lastIndexOf(':')) ?? null) : before.slice(0, before.lastIndexOf(':'));
        if (again.has(at)) {
          if (lapsed) { write(board => endJobs(board.db, [job], { reason: 'the shard lapsed a second time' })); return { refused: `shard job ${job} lapsed on runner ${runner} after it was re-offered once; push again` }; }
        } else {
          again.add(at);
          const next = write(board => reoffer(board, job, runner));
          say?.(`pre-push: shard job ${job} ${infra ? 'posted an infrastructure failure' : 'lapsed'} on runner ${runner}; offered again as ${next}`);
          claimedAt.delete(job); jobs[at] = next; moved = now();
          continue;
        }
      }
      if (receipt && !posted.has(job)) {
        posted.set(job, receipt.payload); moved = now();
        timing?.set(at, { runner: receipt.payload?.runner ?? view.leaseOwner ?? null, wallMs: now() - (claimedAt.get(job)?.at ?? began) });
        continue;
      }
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
 * The board_meta row a finished push gate leaves: `{ at, source, shards, files, runners, wallMs, parts }`, each part the
 * shard's file count, runner and wall time. A pure shape, so the row reads the same on green, red and unknown finishes [C7,U151,#9371].
 *
 * @param {{ source: string, at: string, wallMs: number, plan: { shards: { files: string[] }[] }, timing: Map<number, { runner: string | null, wallMs: number }> }} done
 * @returns {{ at: string, source: string, shards: number, files: number, runners: number, wallMs: number, parts: { files: number, runner: string | null, wallMs: number | null }[] }}
 */
export function pushTimingRow({ source, at, wallMs, plan, timing }) {
  const parts = plan.shards.map((shard, index) => ({ files: shard.files.length, runner: timing.get(index)?.runner ?? null, wallMs: timing.get(index)?.wallMs ?? null }));
  return { at, source, shards: parts.length, files: parts.reduce((sum, part) => sum + part.files, 0), runners: new Set(parts.map(part => part.runner).filter(Boolean)).size, wallMs, parts };
}

/**
 * Write one push.timing.<source> row and keep only the newest PUSH_TIMING_KEPT. With push.recordTiming off nothing is written.
 * A fault while writing is swallowed: recording never changes the gate's answer [C7,U151,#9371].
 *
 * @param {object} ctx
 * @param {ReturnType<typeof pushTimingRow>} row
 * @param {{ enabled?: boolean, write?: Function }} [options]
 * @returns {boolean} True when a row was written.
 */
export function recordPushTiming(ctx, row, { enabled = pushRecordTimingEnabled(), write = work => withBoard(ctx, work) } = {}) {
  if (!enabled) return false;
  try {
    write(board => {
      writeBoardMeta(board.db, `push.timing.${row.source}`, JSON.stringify(row));
      const rows = listBoardMetaWithPrefix(board.db, 'push.timing.').map(entry => { let at = ''; try { at = JSON.parse(entry.value).at ?? ''; } catch { /* an unreadable row sorts oldest */ } return { key: entry.key, at }; });
      for (const old of rows.sort((a, b) => b.at.localeCompare(a.at) || b.key.localeCompare(a.key)).slice(PUSH_TIMING_KEPT)) deleteBoardMeta(board.db, old.key);
    });
    return true;
  } catch { return false; }
}

/**
 * Run the pre-push full gate as pull shard jobs, or return null when pushShardPlan keeps the one-command gate.
 * Green stamps the pushed tree, as a full gate run does, so a retried push of it is not gated twice.
 *
 * @param {object} ctx - The hook's command context.
 * @param {{ say?: (line: string) => void, wait?: Function, pollMs?: number }} [options]
 * @returns {Promise<{ isGreen: boolean, problem: string | null, jobs: string[] } | null>}
 */
export async function pushShardGate(ctx, { say, wait, pollMs, now = Date.now, record = recordPushTiming } = {}) {
  const root = ctx.info.root;
  const runners = ctx.config?.pushGate?.sizeFromBoard === true ? await import('../commands/runner.js').then(module => module.liveRunnerCount(ctx)) : undefined;
  const plan = await pushShardPlan(root, ctx.config, { runners });
  if (!plan) {
    const reason = await pushShardFacts(root, ctx.config).then(pushShardSkipReason, () => null);
    if (reason) say?.(`pre-push: running the one-command gate instead of shard jobs: ${reason}`);
    return null;
  }
  const { jobs, ref, reoffer } = await offerPushShards(ctx, plan);
  const files = plan.shards.reduce((sum, shard) => sum + shard.files.length, 0);
  say?.(`pre-push: the full gate's ${files} test files are offered as ${jobs.length} shard jobs at ${plan.source.slice(0, 12)}; every free runner pulls them`);
  const timing = new Map(), began = now();
  const settled = await awaitAndWithdraw(ctx, jobs, { say, wait, pollMs, limitMs: plan.limitMs, reoffer, timing, after: () => { try { git(root, ['update-ref', '-d', ref]); } catch { /* a pin left behind only keeps a commit reachable */ } } });
  try { record(ctx, pushTimingRow({ source: plan.source.slice(0, 12), at: new Date(now()).toISOString(), wallMs: now() - began, plan, timing })); } catch { /* recording never changes the gate's answer */ }
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
