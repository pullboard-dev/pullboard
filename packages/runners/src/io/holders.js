/** Sort a runner's live resource holders into the controller's live jobs, orphans it no longer owns, and the rest [C7]. */
import { environmentAdapter } from '../../../env/index.js';

/**
 * A worker holder younger than this is never judged an orphan: its controller may have admitted it after it read
 * its live job list, so only an old holder that the controller does not name is one it has lost.
 */
export const ORPHAN_MIN_AGE_MS = 5 * 60_000;

const JOB_ID = /^[A-Za-z0-9._-]{1,128}$/u;

/**
 * The controller's live job ids from an idle request, or null when the request names none (an older controller),
 * which keeps the whole-host idle proof.
 *
 * @param {{ liveJobs?: unknown }} request
 * @returns {Set<string>|null}
 */
export function liveJobSet(request) {
  const jobs = request?.liveJobs;
  if (!Array.isArray(jobs) || jobs.length > 1024 || !jobs.every(id => typeof id === 'string' && JOB_ID.test(id))) return null;
  return new Set(jobs);
}

/** Whether a holder row is a remote job's worker slot, not its short source-cache pin or a local gate. */
function workerSlot(holder) {
  return typeof holder.agent === 'string' && holder.agent.startsWith('pullboard-ssh-') && !holder.agent.startsWith('pullboard-ssh-pin-');
}

/**
 * Split live holders by whether the controller still owns them. A worker slot the controller names is its live job
 * and costs only its own slot. One it does not name, older than ORPHAN_MIN_AGE_MS, whose worker came over SSH from
 * this same controller address, is an orphan. Everything else blocks the idle proof as before.
 * Why: #2828's controller died while the ssh ControlMaster kept the session open, so its worker lived 5 h 40 min and
 * held its lease; every heal probe then read "runner resource lease is active" and .51 and .52 stayed dark (8 Nov).
 *
 * @param {object[]} holders - Holder rows from the runner's own resource pool.
 * @param {Set<string>|null} live - liveJobSet of the request.
 * @param {{ now?: number, alive: (pid: number) => boolean, clientOf?: (pid: number) => string|null, client?: string|null }} observe - `clientOf`
 *   reads a worker's SSH client address; without one no holder is ever judged an orphan.
 * @returns {{ blocking: object[], liveSlots: object[], orphans: object[] }}
 */
export function sortHolders(holders, live, { now = Date.now(), alive, clientOf = () => null, client = currentSshClient() }) {
  const sorted = { blocking: [], liveSlots: [], orphans: [] };
  for (const holder of holders) {
    if (!alive(holder.pid)) continue;
    if (!live || !workerSlot(holder)) { sorted.blocking.push(holder); continue; }
    if (live.has(String(holder.item ?? '')) || live.has(String(holder.token ?? ''))) { sorted.liveSlots.push(holder); continue; }
    const since = Date.parse(holder.since ?? '');
    const old = Number.isFinite(since) && now - since >= ORPHAN_MIN_AGE_MS;
    const ours = Boolean(client) && Number.isSafeInteger(holder.pid) && clientOf(holder.pid) === client;
    (old && ours ? sorted.orphans : sorted.blocking).push(holder);
  }
  return sorted;
}

/** The address this process's own SSH session came from, or null outside SSH. */
export function currentSshClient(env = environmentAdapter().all()) {
  return /^(\S+)\s/u.exec(env.SSH_CLIENT ?? '')?.[1] ?? null;
}

/**
 * Ask each orphan worker to stop with SIGTERM, only while its pid still runs the pinned worker command; the worker's
 * own signal custody then ends its job processes and releases its lease. Returns the pids signalled.
 *
 * @param {object[]} orphans
 * @param {(command: string) => boolean} isWorker - runnerWorkerMatcher for this runner root.
 * @param {{ commandOf: (pid: number) => string|null, kill?: (pid: number, signal: string) => void }} observe
 * @returns {number[]}
 */
export function stopOrphanWorkers(orphans, isWorker, { commandOf, kill = (pid, signal) => process.kill(pid, signal) }) {
  const stopped = [];
  for (const holder of orphans) {
    const command = commandOf(holder.pid);
    if (typeof command !== 'string' || !isWorker(command)) continue;
    try { kill(holder.pid, 'SIGTERM'); stopped.push(holder.pid); } catch { /* A worker gone meanwhile needs no signal. */ }
  }
  return stopped;
}
