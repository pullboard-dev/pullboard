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
import { reserveReview as reserveReviewJob } from "../../../../jobs/index.js";
import { renewReview as renewReviewJob } from "../../../../jobs/index.js";
import { reclaimLapsedReviews as reclaimLapsedReviewJobs } from "../../../../jobs/index.js";
import { releaseReview as releaseReviewJob } from "../../../../jobs/index.js";
import { reviewJobId } from "../../../../jobs/index.js";
import { LEASE_MS } from "../../../../jobs/index.js";
import { Refused } from "../../../../kernel/light.js";
import { runsStoreOn } from "./sqlite.js";
import { runSummary } from "../../logic/board/runs.js";
import { RUN_APPLIED_EVENT } from "../../logic/board/runs.js";
import { RUN_QUEUED_EVENT } from "../../logic/board/runs.js";
import { PENDING_STEP } from "./runs.js";
import { runsPort } from "./runs.js";
import { jobsOf } from "../../../../jobs/index.js";
import { releaseLease } from "../../../../jobs/index.js";

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
 * Write a gate verdict's run row: one row per verdict job, state `awaiting` while main's receipts are outstanding, then
 * `done` (or `withdrawn`) with its outcome. The record carries what the verdict needs to be judged again or read back.
 * Why: with runs_store on a verdict waiting for main is a board run row, not a job step on the board's job tables [B2,M3].
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's handle, inside the move.
 * @param {{ id: string, item: number, candidate: string, base?: string | null, state: 'awaiting'|'done'|'withdrawn', outcome?: string | null, record: object, now?: number }} verdict
 * @returns {{ id: string, state: string }}
 */
export function writeVerdictRun(db, { id, item, candidate, base = null, state, outcome = null, record, now = Date.now() }) {
  db.prepare(`INSERT INTO run (run_job, run_kind, run_item, run_candidate, run_base, run_state, run_outcome, run_record, run_created, run_updated)
    VALUES (?, 'gate-verdict', ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (run_job) DO UPDATE SET run_state = excluded.run_state, run_outcome = excluded.run_outcome, run_record = excluded.run_record, run_updated = excluded.run_updated`)
    .run(id, item, candidate, base, state, outcome, JSON.stringify(record), now, now);
  return { id, state };
}

/**
 * The gate verdicts still waiting on main, oldest first, each with the record it was written with.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ id: string, item: number, candidate: string, record: Record<string, any> }[]}
 */
export function awaitingVerdictRuns(db) {
  return db.prepare("SELECT run_job, run_item, run_candidate, run_record FROM run WHERE run_kind = 'gate-verdict' AND run_state = 'awaiting' ORDER BY run_created, rowid").all()
    .map(row => ({ id: row.run_job, item: row.run_item, candidate: row.run_candidate, record: JSON.parse(row.run_record) }));
}

/**
 * Hold an item's review on its run row's lease columns: the row `review:<item>` is created queued on first sight and
 * taken for the reviewer unless another reviewer's lease is still live. Written in the caller's move, never as a job row.
 * Why: with runs_store on a review lease is board data a move decides on, so it lives on the board's run row [B2].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item
 * @param {string} reviewer
 * @param {{ now?: number, leaseMs?: number }} [options]
 * @returns {{ reserved: boolean, holder: string | null }}
 */
export function reserveReviewRun(db, item, reviewer, { now = Date.now(), leaseMs = LEASE_MS } = {}) {
  if (!reviewer) throw new Refused('REVIEW_RESERVER', 'A review reservation needs a reviewer: pass the agent id.');
  const job = reviewJobId(item);
  const taken = db.prepare(`INSERT INTO run (run_job, run_kind, run_item, run_state, run_lease_owner, run_lease_until, run_created, run_updated)
    VALUES (?, 'review', ?, 'queued', ?, ?, ?, ?)
    ON CONFLICT (run_job) DO UPDATE SET run_state = 'queued', run_lease_owner = excluded.run_lease_owner, run_lease_until = excluded.run_lease_until, run_updated = excluded.run_updated
    WHERE run.run_lease_until < ?`).run(job, item, reviewer, now + leaseMs, now, now, now).changes === 1;
  return { reserved: taken, holder: taken ? reviewer : boardRun(db, job)?.run_lease_owner ?? null };
}

/** Renew a reviewer's reservation on the run row; false when the lease lapsed or moved to another reviewer. */
export function renewReviewRun(db, item, reviewer, { now = Date.now(), leaseMs = LEASE_MS } = {}) {
  return db.prepare('UPDATE run SET run_lease_until = ?, run_updated = ? WHERE run_job = ? AND run_kind = ? AND run_lease_owner = ? AND run_lease_until >= ?')
    .run(now + leaseMs, now, reviewJobId(item), 'review', reviewer, now).changes === 1;
}

/**
 * Clear every review lease on a run row that lapsed, as the jobs cell does for job leases: a reviewer seen within the
 * lease window while its item is still submitted has its lease extended to that sighting instead.
 *
 * @returns {{ item: number, reviewer: string, lapsedMs: number }[]} The reservations reclaimed by this pass.
 */
export function reclaimLapsedReviewRuns(db, { now = Date.now(), leaseMs = LEASE_MS, seen = () => null, submitted = () => true } = {}) {
  const rows = db.prepare("SELECT run_job, run_item, run_lease_owner, run_lease_until FROM run WHERE run_kind = 'review' AND run_lease_owner IS NOT NULL AND run_lease_until < ? ORDER BY run_lease_until").all(now);
  const reclaimed = [];
  for (const row of rows) {
    const sighting = seen(row.run_lease_owner);
    if (Number.isFinite(sighting) && sighting <= now && sighting + leaseMs >= now && submitted(row.run_item) === true) {
      db.prepare('UPDATE run SET run_lease_until = ? WHERE run_job = ? AND run_lease_owner = ?').run(sighting + leaseMs, row.run_job, row.run_lease_owner);
      continue;
    }
    const cleared = db.prepare('UPDATE run SET run_lease_owner = NULL, run_updated = ? WHERE run_job = ? AND run_lease_owner = ? AND run_lease_until < ?')
      .run(now, row.run_job, row.run_lease_owner, now);
    if (cleared.changes === 1) reclaimed.push({ item: row.run_item, reviewer: row.run_lease_owner, lapsedMs: now - row.run_lease_until });
  }
  return reclaimed;
}

/** End an item's review on its run row whoever holds it; returns the reviewer whose lease ended, or null. */
export function releaseReviewRun(db, item, { now = Date.now() } = {}) {
  const run = boardRun(db, reviewJobId(item));
  if (!run || run.run_state === 'done') return null;
  db.prepare("UPDATE run SET run_lease_owner = NULL, run_lease_until = 0, run_state = 'done', run_updated = ? WHERE run_job = ?").run(now, run.run_job);
  return run.run_lease_owner;
}

/**
 * The board's review-lease engine port: each call goes to the run row while runs_store is on and to the jobs cell's
 * job lease while it is off, so a move holds one kind of lease and writes no job row with the flag on [B2].
 */
export const reviewLeases = Object.freeze({
  reserveReview: (db, ...args) => (runsStoreOn(db) ? reserveReviewRun : reserveReviewJob)(db, ...args),
  renewReview: (db, ...args) => (runsStoreOn(db) ? renewReviewRun : renewReviewJob)(db, ...args),
  reclaimLapsedReviews: (db, ...args) => (runsStoreOn(db) ? reclaimLapsedReviewRuns : reclaimLapsedReviewJobs)(db, ...args),
  releaseReview: (db, ...args) => (runsStoreOn(db) ? releaseReviewRun : releaseReviewJob)(db, ...args),
});

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

/**
 * End an item's live gate job as cancelled through the runs port, so its runner's next renew or receipt is refused [C7,#3860].
 * A job already done or cancelled is left as it is; an item with no live gate job writes nothing.
 *
 * Why the lease is freed too: the cancelled step alone leaves the runner's lease standing, and a renew on a standing lease would succeed.
 *
 * @param {any} board - The open board, whose job tables serve while runs_store is off.
 * @param {number} item
 * @param {{ runs?: { db: import('node:sqlite').DatabaseSync } | null, now?: number, reason?: string }} [options] - runs: the board's runs holder while runs_store is on.
 * @returns {{ written: boolean, jobs: string[] }} jobs: the gate jobs this call cancelled.
 */
export function cancelGateJob(board, item, { runs = null, now = Date.now(), reason = 'withdrawn' } = {}) {
  const db = runs?.db ?? board.db;
  const port = runsPort({ db });
  const cancelled = [];
  for (const view of jobsOf(db, { kind: 'gate', item })) {
    if (['done', 'cancelled'].includes(view.step)) continue;
    if (!port.cancel(view.id, { reason, now }).written) continue;
    if (view.leaseOwner) releaseLease(db, view.id, view.leaseOwner, { now });
    cancelled.push(view.id);
  }
  return { written: cancelled.length > 0, jobs: cancelled };
}
