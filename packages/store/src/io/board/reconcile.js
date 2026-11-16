/**
 * The reconciler tick: settle every board-and-runs disagreement the design's crash table names [B2,P7].
 *
 * Why: the board and the runs file commit separately, so a crash or a lost runs file leaves them disagreeing
 * (~/pbseat/coord/runner-store-design.md, section 2). One tick reads the board and the runs file, never writes the
 * board while reading, and ends each disagreeing job in the action its row names. It runs at most every 5 s in the
 * serve loop and once in doctor. Rows that move the board (`lost`, `runaway`) do so in their own board write, after
 * every read of that job is done, so no board decision reads runs inside a write.
 */
import { jobView } from "../../../../jobs/index.js";
import { PENDING_STEP } from "./runs.js";
import { INTENT_GRACE_MS } from "./run.js";
import { applyRunReceipt } from "./run.js";
import { settleRunWithoutReceipt } from "./run.js";
import { boardRun } from "./run.js";

/** The longest the serve loop leaves between ticks. */
export const RECONCILE_EVERY_MS = 5000;

/** How long a queued run whose job the runs file no longer holds waits before the board marks it lost. */
export const LOST_GRACE_MS = INTENT_GRACE_MS;

/** The claim count at which a job is a runaway (design section 6: gate.jobMaxAttempts, 12). */
export const RUNAWAY_ATTEMPTS = 12;

/** The outcome a lost run takes; the item's existing infrastructure path resubmits on it. */
export const RUN_LOST = 'RUN_LOST';

/** The outcome a runaway run takes. */
export const RUN_RUNAWAY = 'RUN_RUNAWAY';

/**
 * The action one disagreement row names. Pure: it reads only the facts it is given.
 *
 * @param {{ run: {run_state: string, run_attempt: number, run_created: number}|null, job: {step: string, attempt: number, created: number}|null,
 *   applied: boolean, receipt: number|null, now: number, cap?: number }} facts - `receipt` is the newest receipt attempt in the runs file, or null.
 * @returns {'wait'|'abandon'|'confirm'|'lost'|'apply'|'mark-applied'|'cancel'|'stale'|'runaway'|'settled'}
 */
export function disagreementAction({ run, job, applied, receipt, now, cap = RUNAWAY_ATTEMPTS }) {
  if (!run) {
    if (job?.step !== PENDING_STEP) return 'settled';
    return now - job.created < INTENT_GRACE_MS ? 'wait' : 'abandon';
  }
  const live = job && !['done', 'cancelled'].includes(job.step);
  if (run.run_state === 'withdrawn') return live ? 'cancel' : 'settled';
  const unapplied = receipt !== null && !applied;
  if (run.run_state === 'done') {
    if (!unapplied) return 'settled';
    return receipt < run.run_attempt ? 'stale' : 'mark-applied';
  }
  if (run.run_state !== 'queued') return 'settled';
  if (!job) return now - run.run_created >= LOST_GRACE_MS ? 'lost' : 'wait';
  if (job.step === PENDING_STEP) return 'confirm';
  if (unapplied) return receipt > run.run_attempt ? 'apply' : 'stale';
  if (live && job.attempt >= cap) return 'runaway';
  return 'settled';
}

/** The job ids a tick looks at: every open or withdrawn board run, and every runs-file job pending or holding an unapplied receipt. */
function candidates(board, runs) {
  const ids = new Set(board.db.prepare("SELECT run_job FROM run WHERE run_state IN ('queued', 'withdrawn')").all().map(row => row.run_job));
  for (const row of runs.db.prepare("SELECT job_id FROM job WHERE job_applied IS NULL AND job_step IN ('pending', 'done')").all()) ids.add(row.job_id);
  return [...ids].sort();
}

/**
 * One reconciler tick: read the board and the runs file, then settle each disagreeing job by its row's action.
 *
 * @param {any} board - The open board; read here, written only by the `lost` and `runaway` moves.
 * @param {{ db: import('node:sqlite').DatabaseSync }} runs - The open runs file.
 * @param {ReturnType<import('./runs.js').runsPort>} port - Every write to the runs file goes through it.
 * @param {{ by?: string, now?: number, cap?: number }} [options]
 * @returns {{ job: string, action: string }[]} The jobs that needed an action, in job order.
 */
export function reconcileTick(board, runs, port, { by = 'coordinator', now = board.clock.now().getTime(), cap = RUNAWAY_ATTEMPTS } = {}) {
  const plan = candidates(board, runs).map(id => {
    const run = boardRun(board.db, id), job = jobView(runs.db, id);
    const applied = job ? runs.db.prepare('SELECT job_applied FROM job WHERE job_id = ?').get(id).job_applied !== null : false;
    const receipts = job?.steps.filter(step => step.name === 'receipt').map(step => step.seq) ?? [];
    const receipt = receipts.length ? Math.max(...receipts) : null;
    return { id, run, receipt, action: disagreementAction({ run, job: job && { step: job.step, attempt: job.attempt, created: job.created }, applied, receipt, now, cap }) };
  });
  const done = [];
  for (const { id, run, receipt, action } of plan) {
    if (action === 'settled' || action === 'wait') continue;
    if (action === 'abandon') port.cancel(id, { reason: 'abandoned', now });
    else if (action === 'confirm') port.confirm(id, { now });
    else if (action === 'cancel') port.cancel(id, { reason: 'withdrawn', now });
    else if (action === 'lost') settleRunWithoutReceipt(board, { by, job: id, state: 'lost', outcome: RUN_LOST });
    else if (action === 'runaway') {
      port.cancel(id, { reason: 'runaway', now });
      settleRunWithoutReceipt(board, { by, job: id, state: 'runaway', outcome: RUN_RUNAWAY });
    } else if (action === 'apply') {
      const step = jobView(runs.db, id).steps.findLast(row => row.name === 'receipt' && row.seq === receipt);
      const body = step?.payload?.receipt ?? {};
      applyRunReceipt(board, { by, job: id, attempt: receipt, outcome: String(body.outcome ?? body.status ?? 'unknown'), summary: body });
      port.ack(id, receipt, { now });
    } else if (action === 'mark-applied' || action === 'stale') port.ack(id, receipt ?? run.run_attempt, { now });
    done.push({ job: id, action });
  }
  return done;
}

/**
 * A tick that holds itself to the cadence: a call sooner than `every` after the last run does nothing, so a serve
 * loop may call it as often as it likes.
 *
 * @param {() => ReturnType<typeof reconcileTick>} tick - One reconciler tick.
 * @param {{ every?: number, clock?: () => number }} [options]
 * @returns {() => ReturnType<typeof reconcileTick>|null} The tick's result, or null when it was too soon.
 */
export function pacedReconciler(tick, { every = RECONCILE_EVERY_MS, clock = Date.now } = {}) {
  let last = -Infinity;
  return () => {
    const at = clock();
    if (at - last < every) return null;
    last = at;
    return tick();
  };
}
