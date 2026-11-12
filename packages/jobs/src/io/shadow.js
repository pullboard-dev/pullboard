/** The submit hand-off record, owned by the gate job's rows: every save is a step carrying the whole record [C7]. */
import { createJob } from "./store.js";
import { writeStep } from "./store.js";
import { Refused } from "../../../kernel/light.js";

/**
 * Write one submit-handoff state change as a step of its gate job, creating the job row on first sight: submit's
 * queue is the job's creation. The step's payload carries the whole record, so the job row is where submitHandoff()
 * reads it back, and the only place it is kept.
 *
 * Why: every state change is a step, so a repeat of the same state is a new step (its seq is the count already
 * written under that name), and the item's latest step is its current record (#3476).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item - The item the gate runs for.
 * @param {Record<string, any>} handoff - The submit-handoff record just saved.
 * @param {{now?: number}} [options]
 * @returns {{job: string, step: string, seq: number}}
 */
export function shadowSubmitHandoff(db, item, handoff, { now = Date.now() } = {}) {
  // An older board gains the tables on its next owning open, which every writing command performs first.
  if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('job', 'job_step')").get().n !== 2) {
    throw new Refused('JOB_TABLES_MISSING', 'This board has no job tables yet: run any board command from the main checkout once, then submit again.');
  }
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

