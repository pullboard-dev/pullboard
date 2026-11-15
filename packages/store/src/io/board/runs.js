/**
 * The five-call port the board uses to reach its runs file [B2,P7].
 *
 * Why: runner traffic (offers, claims, leases, progress, raw receipts) wrote the board file and held its move lock;
 * the runner-store split moves it into a runs file with its own lock (opened by sqlite.js). Only the five calls below
 * cross the boundary, so a hosted runner pool later is a different port, not a redesign
 * (~/pbseat/coord/runner-store-design.md, sections 2 and 7). Everything stays behind the board_meta `runs_store` flag,
 * off until the split's last item.
 */
import { atomically } from "../../../../jobs/index.js";
import { createJob } from "../../../../jobs/index.js";
import { jobView } from "../../../../jobs/index.js";
import { writeStep } from "../../../../jobs/index.js";
import { markApplied } from "../../../../jobs/index.js";

/** The step a job holds after intend and before confirm: written, never claimable. */
export const PENDING_STEP = 'pending';

/** The five calls of the runs port, the only ones the board may make on the runs file. */
export const RUNS_PORT_CALLS = Object.freeze(['intend', 'confirm', 'cancel', 'receiptsSince', 'ack']);

/**
 * The five calls the board makes on a runs file. Each is one runs transaction and each is safe to repeat.
 *
 * @param {{ db: import('node:sqlite').DatabaseSync }} runs - A holder whose `db` is the open runs file.
 */
export function runsPort(runs) {
  return Object.freeze({
    /** Write a job, pending and unclaimable, with its whole request; a repeat of the id writes nothing. */
    intend({ id, kind, item = null, candidate = null, base = null, request = {}, now = Date.now() }) {
      const db = runs.db;
      return atomically(db, () => {
        if (jobView(db, id)) return { written: false, job: jobView(db, id) };
        createJob(db, { id, kind, item, candidate, base, now });
        writeStep(db, id, PENDING_STEP, { request }, { now });
        return { written: true, job: jobView(db, id) };
      });
    },
    /** Offer a pending job once the board's run row has committed; a job past pending is left as it is. */
    confirm(id, { payload = {}, now = Date.now() } = {}) {
      const db = runs.db;
      return atomically(db, () => {
        if (jobView(db, id)?.step !== PENDING_STEP) return { written: false };
        writeStep(db, id, 'offered', payload, { now });
        return { written: true };
      });
    },
    /** End a job the board withdrew; the runner's next renew or receipt is refused. A finished job stays finished. */
    cancel(id, { reason = 'withdrawn', now = Date.now() } = {}) {
      const db = runs.db;
      return atomically(db, () => {
        const step = jobView(db, id)?.step;
        if (!step || step === 'done' || step === 'cancelled') return { written: false };
        writeStep(db, id, 'cancelled', { reason }, { now });
        return { written: true };
      });
    },
    /** Receipts of jobs the board has not marked applied, written after `cursor` (a step id), oldest first. */
    receiptsSince(cursor = 0, { limit = 100 } = {}) {
      return runs.db.prepare(`SELECT r.job_step_id AS cursor, r.job_step_job AS job, r.job_step_seq AS attempt FROM job_step r JOIN job ON job.job_id = r.job_step_job
        WHERE r.job_step_name = 'receipt' AND r.job_step_id > ? AND job.job_applied IS NULL ORDER BY r.job_step_id LIMIT ?`).all(cursor, limit)
        .map(row => ({ cursor: row.cursor, job: row.job, attempt: row.attempt }));
    },
    /** Set the job's inbox mark once the board has applied its receipt; a repeat writes nothing. */
    ack(id, attempt, { now = Date.now() } = {}) {
      return { written: markApplied(runs.db, id, { now }) };
    },
  });
}
