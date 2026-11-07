/** The fallback reclaim pass a board command runs before answering: one reclaimLapsed read, at most one driveOnce (RFC 0008 DJ15) [C7]. */
import { Refused } from '../../../kernel/index.js';
import { jobView } from '../../../jobs/index.js';
import { reclaimLapsed } from '../../../jobs/index.js';
import { phaseOf } from '../core/drive-phase.js';
import { driveOnce } from './drive-once.js';

/** The longest a command's fallback drive may hold its answer; past it the command answers and the lease lapses. */
export const FALLBACK_BUDGET_MS = 1000;

/**
 * The lapsed gate jobs a fallback pass may drive, oldest lapse first: one reclaimLapsed read, without the dispatcher
 * row (ensured, never driven) and without jobs already at their verdict.
 *
 * Why: a command that sees none opens no write handle, so `next` and `status` stay read-only on a healthy board.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now?: number }} [options]
 * @returns {{ id: string, kind: string, step: string, leaseOwner: string, lapsedMs: number }[]}
 */
export function lapsedGateJobs(db, { now = Date.now() } = {}) {
  return reclaimLapsed(db, { now }).filter((job) => {
    if (job.kind !== 'gate') return false;
    const view = jobView(db, job.id);
    return Boolean(view) && phaseOf(view) !== 'verdict';
  });
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
  const budget = new Promise((done) => { timer = setTimeout(() => done({ pending: true }), budgetMs); timer.unref?.(); });
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
 * @param {{ owner: string, now?: () => number, budgetMs?: number, drive?: typeof driveOnce } & Record<string, any>} options
 *   owner is this command's driver id; the rest (repo, runner, plan, transport, sections) passes to driveOnce.
 * @returns {Promise<{ lapsed: number, driven: string | null, transition?: string | null, phase?: string,
 *   pending?: boolean, code?: string }>}
 */
export async function reclaimPass(db, { owner, now = Date.now, budgetMs = FALLBACK_BUDGET_MS, drive = driveOnce, ...options } = /** @type {any} */ ({})) {
  if (!owner) throw new Refused('DRIVE_OWNER', 'reclaimPass needs a driver id to hold the lease: pass { owner }.');
  const lapsed = lapsedGateJobs(db, { now: now() });
  if (!lapsed.length) return { lapsed: 0, driven: null };
  const job = lapsed[0].id;
  try {
    const outcome = await withinBudget(Promise.resolve().then(() => drive(db, job, { ...options, owner, now })), budgetMs);
    if ('pending' in outcome) return { lapsed: lapsed.length, driven: job, pending: true };
    const result = { lapsed: lapsed.length, driven: job, transition: outcome.transition, phase: outcome.phase };
    return outcome.code ? { ...result, code: outcome.code } : result;
  } catch (error) {
    return { lapsed: lapsed.length, driven: job, code: error instanceof Refused ? error.code : 'DRIVE_FAILED' };
  }
}
