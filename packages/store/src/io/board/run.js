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
import { shadowSubmitHandoff } from "../../../../jobs/index.js";
import { runsStoreOn } from "./sqlite.js";
import { runSummary } from "../../logic/board/runs.js";
import { RUN_APPLIED_EVENT } from "../../logic/board/runs.js";
import { RUN_QUEUED_EVENT } from "../../logic/board/runs.js";
import { PENDING_STEP } from "./runs.js";

/** How long a pending job with no board run may wait for its move before the reconciler abandons it. */
export const INTENT_GRACE_MS = 10 * 60 * 1000;


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
    logEvent(board, by, RUN_QUEUED_EVENT, item, { job: id, kind, candidate, base, state: 'queued', attempt: 0 }, new Date(now));
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

/**
 * Apply one receipt to the board in one move keyed by job and attempt: a queued run whose applied attempt is older
 * takes the outcome, the capped summary and an event; anything else (no run, a run already done or withdrawn, an
 * attempt not newer than the applied one) changes nothing.
 *
 * @param {any} board
 * @param {{ by: string, job: string, attempt: number, outcome: string, summary?: object }} receipt - Read from the runs file before this write opens.
 * @returns {{ applied: boolean }}
 */
export function applyRunReceipt(board, { by, job, attempt, outcome, summary = {} }) {
  return atomic(board, () => {
    const run = boardRun(board.db, job);
    if (!run || run.run_state !== 'queued' || !(attempt > run.run_attempt)) return { applied: false };
    const now = board.clock.now().getTime();
    const kept = runSummary(summary);
    board.db.prepare("UPDATE run SET run_state = 'done', run_attempt = ?, run_outcome = ?, run_summary = ?, run_updated = ? WHERE run_job = ? AND run_state = 'queued' AND run_attempt < ?")
      .run(attempt, outcome, JSON.stringify(kept), now, job, attempt);
    logEvent(board, by, RUN_APPLIED_EVENT, run.run_item, { job, attempt, outcome, summary: kept, state: 'done' }, new Date(now));
    return { applied: true };
  });
}

/**
 * Drain the receipt inbox: for each unacknowledged receipt, read it from the runs file, apply it to the board in its
 * own move, then ack it in the runs file. A crash between the move and the ack leaves the receipt in the inbox, and the
 * next drain's move is a no-op before it acks.
 *
 * @param {any} board
 * @param {{ db: import('node:sqlite').DatabaseSync }} runs - The runs file, read before each board write.
 * @param {ReturnType<import('./runs.js').runsPort>} port
 * @param {{ by: string, limit?: number }} options
 * @returns {{ job: string, attempt: number, applied: boolean }[]}
 */
export function applyReceipts(board, runs, port, { by, limit = 100 }) {
  return port.receiptsSince(0, { limit }).map(({ job, attempt }) => {
    const step = jobView(runs.db, job)?.steps.find(row => row.name === 'receipt' && row.seq === attempt);
    const receipt = step?.payload?.receipt ?? {};
    const { applied } = applyRunReceipt(board, { by, job, attempt, outcome: String(receipt.outcome ?? receipt.status ?? 'unknown'), summary: receipt });
    port.ack(job, attempt);
    return { job, attempt, applied };
  });
}

/**
 * Move a run to a settled state the board decides alone (`lost`, `runaway`): one board write, logged like a receipt so
 * a replay of the events rebuilds the row. A run that is no longer queued changes nothing.
 *
 * @param {any} board
 * @param {{ by: string, job: string, state: 'lost'|'runaway', outcome: string }} move
 * @returns {{ applied: boolean }}
 */
export function settleRunWithoutReceipt(board, { by, job, state, outcome }) {
  return atomic(board, () => {
    const run = boardRun(board.db, job);
    if (!run || run.run_state !== 'queued') return { applied: false };
    const now = board.clock.now().getTime();
    board.db.prepare("UPDATE run SET run_state = ?, run_outcome = ?, run_summary = '{}', run_updated = ? WHERE run_job = ? AND run_state = 'queued'").run(state, outcome, now, job);
    logEvent(board, by, RUN_APPLIED_EVENT, run.run_item, { job, attempt: run.run_attempt, outcome, summary: {}, state }, new Date(now));
    return { applied: true };
  });
}

/**
 * Save a submit hand-off record: onto the gate job's run row while runs_store is on, else as a step of its job (the jobs
 * cell's writer, unchanged). The row is created queued on first sight and only its record is replaced afterwards, in the
 * caller's transaction, so the record commits or rolls back with the move that saved it.
 * Why: with the flag on the board's run row is the one place a run's record lives, and the runs file keeps the runner traffic [B2,M3].
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's handle, inside the move.
 * @param {number} item - The item the gate runs for.
 * @param {Record<string, any>} handoff - The hand-off record just saved.
 * @param {{ now?: number }} [options]
 * @returns {{ job: string, step: string, seq: number }}
 */
export function saveSubmitHandoff(db, item, handoff, { now = Date.now() } = {}) {
  if (!runsStoreOn(db)) return shadowSubmitHandoff(db, item, handoff, { now });
  db.prepare(`INSERT INTO run (run_job, run_kind, run_item, run_candidate, run_base, run_state, run_record, run_created, run_updated)
    VALUES (?, 'gate', ?, ?, ?, 'queued', ?, ?, ?)
    ON CONFLICT (run_job) DO UPDATE SET run_record = excluded.run_record, run_updated = excluded.run_updated`)
    .run(handoff.id, item, handoff.commit, handoff.main ?? null, JSON.stringify(handoff), now, now);
  return { job: handoff.id, step: handoff.state, seq: 0 };
}
