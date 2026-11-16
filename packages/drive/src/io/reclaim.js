/** The fallback reclaim pass a board command runs before answering: one reclaimLapsed read, at most one driveOnce (RFC 0008 DJ15) [C7]. */
import { Refused } from '../../../kernel/index.js';
import { jobView } from '../../../jobs/index.js';
import { reclaimLapsed } from '../../../jobs/index.js';
import { finishJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { phaseOf } from '../logic/phase.js';
import { GATE_DRIVE_KIND } from '../logic/gate.js';
import { driveOnce } from './once.js';

/** The longest a command's fallback drive may hold its answer; past it the command answers and the lease lapses. */
export const FALLBACK_BUDGET_MS = 1000;

/**
 * The lapsed gate jobs a fallback pass may drive, oldest lapse first: one reclaimLapsed read, without the dispatcher
 * row (ensured, never driven) and without jobs already at their verdict.
 *
 * Why: a command that sees none opens no write handle, so `next` and `status` stay read-only on a healthy board.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now?: number, runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options] - runs: the board's runs holder while runs_store is on (boardRunsHolder); the jobs are read from its handle [P7,#9080].
 * @returns {{ id: string, kind: string, step: string, leaseOwner: string, lapsedMs: number }[]}
 */
export function lapsedGateJobs(db, { now = Date.now(), runs = null } = {}) {
  const jobs = runs?.db ?? db;
  return reclaimLapsed(jobs, { now }).filter((job) => {
    // A gate-drive job is listed too, so a stale one is ended; it is never driven here (#4071, SM2).
    if (job.kind !== 'gate' && job.kind !== GATE_DRIVE_KIND) return false;
    const view = jobView(jobs, job.id);
    return Boolean(view) && phaseOf(view) !== 'verdict';
  });
}

/** How long a lapsed gate job may go without a recorded step before a fallback pass ends it instead of renewing it. */
export const GATE_JOB_NO_PROGRESS_MS = 20 * 60_000;

/**
 * End the lapsed gate jobs no driver should take again, before a fallback pass drives one: a job whose item is no
 * longer submitted at that job's candidate commit ends withdrawn and stale; a job with no step for
 * GATE_JOB_NO_PROGRESS_MS ends as infrastructure naming its last step. Each gets its ending step, then `done` with
 * its lease freed, so reclaimLapsed never lists it again.
 *
 * Why: on 9 Nov handoff drive jobs sat at shard.started for 37-41 h for items since verified, withdrawn or reopened;
 * every next and status took their lapsed lease as a fallback driver and renewed it, so they never ended.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id: string }[]} lapsed - The lapsed gate jobs this pass read.
 * @param {{ owner: string, now: number, runs?: { db: import('node:sqlite').DatabaseSync } | null, active?: (view: { item: number|null, candidate: string|null }) => boolean | null }} options
 *   runs: the board's runs holder while runs_store is on; the job rows are read and ended there [P7,#9080].
 *   active answers whether the job's item is still submitted at its candidate (null when unknown); without it only
 *   the no-progress rule applies.
 * @returns {{ id: string, ended: 'stale' | 'infrastructure', lastStep: string | null }[]}
 */
export function endDeadGateJobs(db, lapsed, { owner, now, active, runs = null }) {
  const jobs = runs?.db ?? db;
  const ended = [];
  for (const { id } of lapsed) {
    const view = jobView(jobs, id);
    if (!view || view.step === 'done') continue;
    const last = view.steps.reduce((latest, step) => (!latest || step.at > latest.at ? step : latest), null);
    const lastStep = last?.name ?? null;
    let still = null;
    try { still = typeof active === 'function' ? active(view) : null; } catch { still = null; }
    if (still === false) {
      writeStep(jobs, id, 'withdrawn', { stale: true, reason: view.kind === GATE_DRIVE_KIND
        ? 'its hand-off ended, another replaced it, or its item left the claim the hand-off serves'
        : 'its item is no longer submitted at the head its hand-off submitted', lastStep }, { now });
      finishJob(jobs, id, owner, { now });
      ended.push({ id, ended: 'stale', lastStep });
    } else if (view.kind === 'gate' && now - (last?.at ?? view.created ?? now) >= GATE_JOB_NO_PROGRESS_MS) {
      // A gate-drive job is resumed by its hand-off's recovery (#3995), so only a stale one is ended here.
      writeStep(jobs, id, 'ended', { infrastructure: true, code: 'GATE_JOB_NO_PROGRESS', lastStep,
        reason: `no step for ${Math.round((now - (last?.at ?? now)) / 60_000)} min after ${lastStep ?? 'its creation'}` }, { now });
      finishJob(jobs, id, owner, { now });
      ended.push({ id, ended: 'infrastructure', lastStep });
    }
  }
  return ended;
}

/**
 * Settle with the drive's outcome, or with `{ pending: true }` once the budget ends, whichever comes first. A drive
 * still running past the budget keeps going, and its later failure is swallowed: the job row, not this call, owns
 * the state.
 *
 * @template T
 * @param {Promise<T>} drive
 * @param {number} budgetMs
 * @returns {Promise<T | { pending: true }>}
 */
function withinBudget(drive, budgetMs) {
  drive.catch(() => {});
  let timer;
  const budget = new Promise((done) => { timer = setTimeout(() => done({ pending: true }), budgetMs); });
  return Promise.race([drive, budget]).finally(() => clearTimeout(timer));
}

/**
 * One fallback reclaim pass: list lapsed jobs once, then drive at most one of them by one transition, never waiting
 * longer than the budget. A failed drive (no runner or plan to send to, say) is reported as its refusal code, or
 * DRIVE_FAILED, and never fails the command that ran the pass.
 *
 * Why: the dispatcher reclaims first; this pass is the fallback so a job stalled by a dead dispatcher still moves
 * whenever anyone runs `next` or `status`, without any command waiting on a job (DJ15).
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle, opened for writing.
 * @param {{ owner: string, now?: () => number, budgetMs?: number, drive?: typeof driveOnce, lapsed?: ReturnType<typeof lapsedGateJobs> } & Record<string, any>} options
 *   owner is this command's driver id; lapsed is a list the caller already read with lapsedGateJobs, so the pass
 *   does not read it again; runs: the board's runs holder while runs_store is on, for the lapsed read, the endings and the drive; the rest (repo, runner, plan, transport, sections) passes to driveOnce.
 * @returns {Promise<{ lapsed: number, driven: string | null, transition?: string | null, phase?: string,
 *   pending?: boolean, code?: string }>}
 */
export async function reclaimPass(db, { owner, now = Date.now, budgetMs = FALLBACK_BUDGET_MS, drive = driveOnce, lapsed: known, active, runs = null, ...options } = /** @type {any} */ ({})) {
  if (!owner) throw new Refused('DRIVE_OWNER', 'reclaimPass needs a driver id to hold the lease: pass { owner }.');
  const ended = new Set(endDeadGateJobs(db, known ?? lapsedGateJobs(db, { now: now(), runs }), { owner, now: now(), active, runs }).map(row => row.id));
  // A gate-drive job runs a whole submit gate that only its hand-off worker can drive; the fallback ends a stale one
  // above and leaves a live one to the worker and its recovery.
  const lapsed = (known ?? lapsedGateJobs(db, { now: now(), runs })).filter(row => !ended.has(row.id) && row.kind !== GATE_DRIVE_KIND);
  if (!lapsed.length) return { lapsed: 0, driven: null };
  const job = lapsed[0].id;
  try {
    const outcome = await withinBudget(Promise.resolve().then(() => drive(db, job, { ...options, owner, now, runs })), budgetMs);
    if ('pending' in outcome) return { lapsed: lapsed.length, driven: job, pending: true };
    const result = { lapsed: lapsed.length, driven: job, transition: outcome.transition, phase: outcome.phase };
    return outcome.code ? { ...result, code: outcome.code } : result;
  } catch (error) {
    return { lapsed: lapsed.length, driven: job, code: error instanceof Refused ? error.code : 'DRIVE_FAILED' };
  }
}
