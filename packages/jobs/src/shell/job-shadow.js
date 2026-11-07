/** The submit hand-off record, owned by the gate job's rows: every save is a step carrying the whole record [C7]. */
import { createJob } from "./job-store.js";
import { writeStep } from "./job-store.js";

/**
 * True when the board has both job tables.
 *
 * Why: an older board gains the tables on its next owning open; until then the hand-off lives in board_meta only.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
function hasJobTables(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('job', 'job_step')").get().n === 2;
}

/**
 * Write one submit-handoff state change as a step of its job, creating the job row on first sight. The step's
 * payload carries the whole record, so the job row is where submitHandoff() reads it back.
 *
 * Why: every state change is a step, so a repeat of the same state is a new step (its seq is the count already
 * written under that name), and the item's latest step is its current record. Board_meta keeps a copy until the
 * raw readers move to the job tables (#3476).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item - The item the gate runs for.
 * @param {Record<string, any>} handoff - The submit-handoff record just saved.
 * @param {{now?: number}} [options]
 * @returns {{job: string, step: string, seq: number} | null} Null when the board has no job tables yet.
 */
export function shadowSubmitHandoff(db, item, handoff, { now = Date.now() } = {}) {
  if (!hasJobTables(db)) return null;
  createJob(db, { id: handoff.id, kind: 'gate', item, candidate: handoff.commit, base: handoff.main, now });
  const seq = db.prepare('SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ? AND job_step_name = ?').get(handoff.id, handoff.state).n;
  const payload = { agent: handoff.agentId, commit: handoff.commit, tree: handoff.tree, digest: handoff.digest };
  if (handoff.error?.code) payload.error = handoff.error.code;
  if (handoff.retryOf) payload.retryOf = handoff.retryOf;
  payload.record = handoff;
  writeStep(db, handoff.id, handoff.state, payload, { seq, now });
  return { job: handoff.id, step: handoff.state, seq };
}

/** The job cell's name for the writer: saving a hand-off record onto its gate job. */
export const recordSubmitHandoff = shadowSubmitHandoff;

/**
 * The item's current submit hand-off record: the record on the latest step of its gate jobs.
 *
 * Why: a retry starts a new job for the same item, so the current record is the newest step across the item's gate
 * jobs, not the newest job. Undefined when the board has no job tables or no job step carries a record yet (a
 * hand-off saved before this cell owned the record), so the caller reads its board_meta copy instead.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item
 * @returns {Record<string, any> | undefined}
 */
export function submitHandoffRecord(db, item) {
  if (!hasJobTables(db)) return undefined;
  const row = db.prepare(`SELECT s.job_step_payload AS payload FROM job_step s JOIN job j ON j.job_id = s.job_step_job
    WHERE j.job_kind = 'gate' AND j.job_item = ? AND json_extract(s.job_step_payload, '$.record') IS NOT NULL
    ORDER BY s.job_step_id DESC LIMIT 1`).get(item);
  return row ? JSON.parse(row.payload).record : undefined;
}
