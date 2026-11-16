/** Wait for a pull-mode runner job by reading the local status mirror; no process per job, built-ins only [5465,5468]. */
import { refreshRunnerStatus } from './mirror.js';
import { registerRunnerJob } from './mirror.js';
import { requestRunnerCancel } from './mirror.js';
import { MIRROR_INTERVAL_MS } from './mirror.js';

/** A heartbeat older than this on a running job whose owner is gone means the worker is lost (design section 6). */
export const BEAT_LOST_MS = 20_000;
/** How stale a mirror may be before a waiter refreshes it while its job has not run yet (queued or checking out), where need and ready land. */
export const STARTUP_MIRROR_MS = 500;
/** The same, while its job runs: one shared ssh per runner per second, so a done job is seen within a second. */
export const RUNNING_MIRROR_MS = 1_000;

/**
 * Decide what a fresh mirror says about one job.
 * @param {object} mirror The runner's mirror (`at`, `reachable`, `jobs`).
 * @param {{ id: string, startedAt?: number }} wait The job being waited on and when it was queued: a mirror that began earlier may not list it yet.
 * @returns {{ end: string, finishReason: string|null, cancel?: boolean }|null} The end state, or null to keep waiting.
 */
export function decideJob(mirror, { id, startedAt = 0 }) {
  if (mirror.reachable === false) return { end: 'runner-unreachable', finishReason: 'ssh-exit' };
  if (mirror.failures > 0) return null; // A failed refresh carries the last jobs over; it is not a fresh look at the runner.
  const job = mirror.jobs?.[id];
  if (!job) return mirror.at < startedAt ? null : { end: 'job-lost', finishReason: 'job-lost' };
  if (job.state === 'done') {
    if (job.resultSeen) return { end: 'result', finishReason: null };
    return job.exit?.signal === 'LOST' ? { end: 'job-lost', finishReason: 'job-lost' } : { end: 'ssh-exit', finishReason: 'ssh-exit' };
  }
  return null;
}

/**
 * Decide the clock-driven ends for a job that is not done: a dead worker, the admission deadline, the run ceiling.
 * A deadline fires only on a mirror taken at or after it, so a stale mirror never ends a job that has since started.
 */
function decideClock(mirror, job, { startupDeadline, ceilingMs, readyAt }) {
  if (job.state === 'running' && job.alive === false && (job.beatAgeMs === null || job.beatAgeMs > BEAT_LOST_MS)) {
    return { end: 'job-lost', finishReason: 'job-lost' };
  }
  if (!job.ready && startupDeadline !== null && mirror.at >= startupDeadline) {
    return { end: 'admission-deadline', finishReason: 'admission-deadline', cancel: true };
  }
  if (job.ready && ceilingMs !== null && readyAt !== null && mirror.at - readyAt >= ceilingMs) {
    return { end: 'run-timeout', finishReason: 'run-timeout', cancel: true };
  }
  return null;
}

/**
 * Wait for one pull-mode job to end and say how, from the shared status mirror only.
 * Each tick this reads the mirror and, if it is older than the job's step cadence, refreshes it with one ssh for the
 * whole runner; many waiters on a runner share that refresh. The cadence is 0.5 s until the job is ready (the runner
 * writes need and ready there) and 1 s while it runs, so a step shows within a second of the runner writing it [#8134];
 * `mirror.intervalMs` pins one cadence, and `observe` still runs at most once per 3 s mirror so the board is not asked more often. The job's end maps to a finish reason:
 * result -> null, done without a result or unreachable runner -> 'ssh-exit', lost worker -> 'job-lost',
 * admission deadline -> 'admission-deadline', run ceiling -> 'run-timeout', abort -> 'canceled',
 * and whatever `observe` reports (item terminal, source changed, lease unavailable) with its own reason.
 * @param {object} options
 * @param {{ host: string, root?: string }} options.runner The runner record.
 * @param {string} options.id The job id.
 * @param {number|null} [options.startupDeadline] Epoch ms by which the job must be ready, or null.
 * @param {number|null} [options.ceilingMs] Milliseconds a ready job may run without a result, or null.
 * @param {AbortSignal} [options.signal] Aborting cancels the job and ends the wait as 'canceled'.
 * @param {number} [options.startedAt] The time the job was queued; a mirror that began earlier and does not list the job is not read as a lost job.
 * @param {(job: object, mirror: object) => ({ end: string, finishReason?: string, error?: Error }|null|Promise<object|null>)} [options.observe]
 *   Called once per fresh mirror while the job is not done: the caller's item-terminal, source-identity and lease checks.
 * @param {(job: object, mirror: object) => void} [options.onReady] Called once when the mirror first shows the job ready; it may throw to end the wait.
 * @param {(id: string, need: string) => Promise<void>} [options.onNeed] Called once with the runner's base64 source inventory; a rejection ends the wait.
 * @param {object} [options.mirror] `dir`, `ssh`, `env`, `now`, `intervalMs` passed to the refresh.
 * @param {number} [options.tickMs] Milliseconds between ticks; default a quarter of the current refresh cadence.
 * @param {number} [options.parentPid] The process whose life keeps the job wanted.
 * @returns {Promise<{ end: string, finishReason: string|null, cancel: boolean, job?: object, error?: Error }>} The end state; never rejects.
 */
export function waitRunnerJob({ runner, id, startupDeadline = null, ceilingMs = null, signal, startedAt = Date.now(), observe, onReady, onNeed, mirror: mirrorOptions = {}, tickMs, parentPid = process.pid }) {
  const dir = mirrorOptions.dir;
  registerRunnerJob(runner.host, id, { dir, pid: parentPid });
  return new Promise(resolve => {
    let ended = false, busy = false, readyAt = null, needSent = false, observedAt = 0, observedClock = -Infinity, cadence = STARTUP_MIRROR_MS, timer;
    const finish = end => {
      if (ended) return;
      ended = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (end.cancel) requestRunnerCancel(runner.host, id, { dir });
      resolve({ cancel: false, ...end });
    };
    const onAbort = () => finish({ end: 'canceled', finishReason: 'canceled', cancel: true });
    const tick = async () => {
      if (ended || busy) return;
      busy = true;
      try {
        const { mirror } = await refreshRunnerStatus(runner, { ...mirrorOptions, intervalMs: mirrorOptions.intervalMs ?? cadence });
        if (ended || !mirror) return;
        const settled = decideJob(mirror, { id, startedAt });
        if (settled) { finish({ ...settled, job: mirror.jobs?.[id] }); return; }
        const job = mirror.jobs?.[id];
        if (!job) return; // A failed refresh: look again next tick.
        if (job.ready && readyAt === null) { readyAt = mirror.at; onReady?.(job, mirror); }
        if (job.need && !needSent && onNeed) { needSent = true; onNeed(id, job.need).catch(error => finish({ end: 'need-failed', finishReason: 'ssh-exit', cancel: true, error })); }
        cadence = job.ready ? RUNNING_MIRROR_MS : STARTUP_MIRROR_MS;
        const slow = mirrorOptions.intervalMs ?? MIRROR_INTERVAL_MS;
        if (mirror.at !== observedAt && mirror.at - observedClock >= slow) {
          observedAt = mirror.at; observedClock = mirror.at;
          const hit = await observe?.(job, mirror);
          if (hit) { finish({ finishReason: hit.end, cancel: true, ...hit, job }); return; }
        }
        const clock = decideClock(mirror, job, { startupDeadline, ceilingMs, readyAt });
        if (clock) finish({ ...clock, job });
      } catch (error) { finish({ end: 'error', finishReason: null, cancel: true, error }); }
      finally { busy = false; }
    };
    /** Look again after one tick; the chain ends with the wait, so it is never a standing loop. */
    const schedule = () => { timer = setTimeout(async () => { await tick(); if (!ended) schedule(); }, tickMs ?? Math.max(50, (mirrorOptions.intervalMs ?? cadence) / 4)); };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    schedule();
    tick();
  });
}
