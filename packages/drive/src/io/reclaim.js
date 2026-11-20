/** The fallback reclaim pass a board command runs before answering: one reclaimLapsed read, at most one driveOnce (RFC 0008 DJ15) [C7]. */
import { Refused } from '../../../kernel/index.js';
import { jobView } from '../../../jobs/index.js';
import { finishJob } from '../../../jobs/index.js';
import { createJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { GATE_DRIVE_KIND } from '../logic/gate.js';
import { driveOnce } from './once.js';
import { lapsedGateJobs } from './lapsed.js';

export { lapsedGateJobs };

/** The longest a command's fallback drive may hold its answer; past it the command answers and the lease lapses. */
export const FALLBACK_BUDGET_MS = 1000;

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
 * @param {{ owner: string, now: number, runs?: { db: import('node:sqlite').DatabaseSync } | null, active?: (view: { item: number|null, candidate: string|null }) => boolean | null, reofferInfraEnd?: boolean }} options
 *   reofferInfraEnd: gate.reofferInfraEnd, offers a gate job that ended as infrastructure once more (default off) [C7,#9633].
 *   runs: the board's runs holder while runs_store is on; the job rows are read and ended there [P7,#9080].
 *   active answers whether the job's item is still submitted at its candidate (null when unknown); without it only
 *   the no-progress rule applies.
 * @returns {{ id: string, ended: 'stale' | 'infrastructure', lastStep: string | null }[]}
 */
export function endDeadGateJobs(db, lapsed, { owner, now, active, runs = null, reofferInfraEnd = false }) {
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
      if (reofferInfraEnd && still !== false) reofferGateJob(jobs, view, { now });
      finishJob(jobs, id, owner, { now });
      ended.push({ id, ended: 'infrastructure', lastStep });
    }
  }
  return ended;
}

/** The id suffix of a re-offered gate job; a job carrying it is never re-offered again. */
const REOFFER_SUFFIX = ':reoffer';

/**
 * Offer a gate job that ended as infrastructure once more for the same item, candidate and base, with the ended job's
 * own request, and record a `reoffered` step on the ended job. At most one per candidate: a candidate that already
 * has a re-offered job, or a job that is itself a re-offer, is left alone.
 * Why: a gate job whose runner went quiet ended GATE_JOB_NO_PROGRESS with no verdict, and nothing offered it again,
 * so the item's claim lapsed with no gate pending (#9497) [C7,#9633].
 *
 * @param {import('node:sqlite').DatabaseSync} jobs
 * @param {NonNullable<ReturnType<typeof jobView>>} view - The ended job.
 * @param {{ now: number }} options
 * @returns {string | null} The new job's id, or null when none was offered.
 */
function reofferGateJob(jobs, view, { now }) {
  if (!view.candidate || view.id.endsWith(REOFFER_SUFFIX)) return null;
  const taken = jobs.prepare("SELECT 1 FROM job WHERE job_kind = 'gate' AND job_item IS ? AND job_candidate = ? AND job_id LIKE ?").get(view.item, view.candidate, `%${REOFFER_SUFFIX}`);
  if (taken) return null;
  const request = view.steps.find(step => step.name === 'request');
  const offered = view.steps.find(step => step.name === 'offered');
  if (!offered) return null;
  const next = `${view.id}${REOFFER_SUFFIX}`;
  createJob(jobs, { id: next, kind: 'gate', item: view.item, candidate: view.candidate, base: view.base, now });
  if (request) writeStep(jobs, next, 'request', request.payload, { now });
  writeStep(jobs, next, 'offered', offered.payload, { now });
  writeStep(jobs, view.id, 'reoffered', { job: next }, { now });
  return next;
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
export async function reclaimPass(db, { owner, now = Date.now, budgetMs = FALLBACK_BUDGET_MS, drive = driveOnce, lapsed: known, active, runs = null, reofferInfraEnd = false, ...options } = /** @type {any} */ ({})) {
  if (!owner) throw new Refused('DRIVE_OWNER', 'reclaimPass needs a driver id to hold the lease: pass { owner }.');
  const ended = new Set(endDeadGateJobs(db, known ?? lapsedGateJobs(db, { now: now(), runs }), { owner, now: now(), active, runs, reofferInfraEnd }).map(row => row.id));
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
