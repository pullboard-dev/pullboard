/** Mirror a submit-handoff record into the job tables without changing the handoff [C7]. */
import { createJob } from "./job-store.js";
import { writeStep } from "./job-store.js";

/**
 * Write one submit-handoff state change as a step of its job, creating the job row on first sight.
 *
 * Why: the hand-off record stays the source of truth while the job tables prove themselves; every state change is
 * a step, so a repeat of the same state is a new step (its seq is the count already written under that name).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} item - The item the gate runs for.
 * @param {Record<string, any>} handoff - The submit-handoff record just saved.
 * @param {{now?: number}} [options]
 * @returns {{job: string, step: string, seq: number}}
 */
export function shadowSubmitHandoff(db, item, handoff, { now = Date.now() } = {}) {
  createJob(db, { id: handoff.id, kind: 'gate', item, candidate: handoff.commit, base: handoff.main, now });
  const seq = db.prepare('SELECT COUNT(*) AS n FROM job_step WHERE job_step_job = ? AND job_step_name = ?').get(handoff.id, handoff.state).n;
  const payload = { agent: handoff.agentId, commit: handoff.commit, tree: handoff.tree, digest: handoff.digest };
  if (handoff.error?.code) payload.error = handoff.error.code;
  if (handoff.retryOf) payload.retryOf = handoff.retryOf;
  writeStep(db, handoff.id, handoff.state, payload, { seq, now });
  return { job: handoff.id, step: handoff.state, seq };
}
