/**
 * Queue a runner job across the board and its runs file: intent, then move, then confirm [B2,P7].
 *
 * Why: SQLite commits each file atomically but never two files together, so the order between them is fixed instead.
 * The runs file first holds the job pending (never claimable), then one board transaction records the run, and only
 * then is the job offered. A crash between any two steps leaves a state the reconciler settles without a person
 * (~/pbseat/coord/runner-store-design.md, section 2). Ids are minted once by the caller and carried through every
 * retry, so a retry writes nothing twice. The board is the authority: where the files disagree, the board wins.
 */
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { jobView } from "../../../../jobs/index.js";
import { PENDING_STEP } from "./runs.js";

/** How long a pending job with no board run may wait for its move before the reconciler abandons it. */
export const INTENT_GRACE_MS = 10 * 60 * 1000;

/** The board event a queued run writes; replay rebuilds the run row from it. */
export const RUN_QUEUED_EVENT = 'run_queued';

/**
 * The board's run row for a job id, or null.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's handle.
 * @param {string} job
 */
export function boardRun(db, job) {
  const row = db.prepare('SELECT * FROM run WHERE run_job = ?').get(job);
  return row ? { ...row } : null;
}

/**
 * Write the board's queued run row and its event in one immediate board transaction. A repeat of the id writes
 * nothing, so a retried move never logs a second event.
 *
 * @param {any} board
 * @param {{ by: string, id: string, kind: string, item?: number|null, candidate?: string|null, base?: string|null }} run
 * @returns {{ written: boolean }}
 */
export function recordQueuedRun(board, { by, id, kind, item = null, candidate = null, base = null }) {
  return atomic(board, () => {
    const now = board.clock.now().getTime();
    const inserted = board.db.prepare(`INSERT OR IGNORE INTO run (run_job, run_kind, run_item, run_candidate, run_base, run_state, run_created, run_updated)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)`).run(id, kind, item, candidate, base, now, now);
    if (inserted.changes === 0) return { written: false };
    logEvent(board, by, RUN_QUEUED_EVENT, item, { job: id, kind, candidate, base, state: 'queued', attempt: 0 });
    return { written: true };
  });
}

/**
 * Queue one job: intent on the runs file, the run row on the board, then the offer on the runs file. Each step is its
 * own transaction and safe to repeat; `onStep` runs after each one commits (tests stop the process there).
 *
 * @param {any} board - The open board.
 * @param {ReturnType<import('./runs.js').runsPort>} port - The board's runs port.
 * @param {{ by: string, id: string, kind: string, item?: number|null, candidate?: string|null, base?: string|null, request?: object, payload?: object }} job
 * @param {{ onStep?: (step: 'intend'|'move'|'confirm') => void }} [options]
 * @returns {{ id: string, offered: boolean }}
 */
export function queueRun(board, port, { by, id, kind, item = null, candidate = null, base = null, request = {}, payload = {} }, { onStep } = {}) {
  const now = () => board.clock.now().getTime();
  port.intend({ id, kind, item, candidate, base, request, now: now() });
  onStep?.('intend');
  recordQueuedRun(board, { by, id, kind, item, candidate, base });
  onStep?.('move');
  const confirmed = port.confirm(id, { payload, now: now() });
  onStep?.('confirm');
  return { id, offered: confirmed.written };
}

/**
 * Settle one job whose queueing may have stopped part way, by the design's disagreement table: no board run and a
 * young pending job waits; no board run and a pending job past the grace is abandoned (nothing ran); a queued run
 * whose job is still pending is confirmed. Reads the board without writing it.
 *
 * @param {any} board - The open board, read only here.
 * @param {{ db: import('node:sqlite').DatabaseSync }} runs - The open runs file, for reading the job.
 * @param {ReturnType<import('./runs.js').runsPort>} port - Writes go through the port.
 * @param {string} id
 * @param {{ now?: number }} [options]
 * @returns {'wait'|'abandoned'|'confirmed'|'settled'|'none'}
 */
export function reconcileQueued(board, runs, port, id, { now = board.clock.now().getTime() } = {}) {
  const run = boardRun(board.db, id);
  const job = jobView(runs.db, id);
  if (!job) return 'none';
  if (!run) {
    if (job.step !== PENDING_STEP) return 'settled';
    if (now - job.created < INTENT_GRACE_MS) return 'wait';
    port.cancel(id, { reason: 'abandoned', now });
    return 'abandoned';
  }
  if (run.run_state === 'queued' && job.step === PENDING_STEP) {
    port.confirm(id, { now });
    return 'confirmed';
  }
  return 'settled';
}
