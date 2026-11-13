/** Read the gate panel for one gate job or for every stalled one [C7]. */
import { jobView } from "../store.js";
import { viewOf } from "../../logic/view.js";
import { readPayload } from "../blobs.js";
import { gatePanelState } from "../../logic/panel.js";

/**
 * The gate panel state of one job, or null when the job table has no such job.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} job
 * @param {{now?: number, workerAlive?: (view: object) => boolean}} [options] - workerAlive says whether a live hand-off worker runs the job.
 * @returns {ReturnType<typeof gatePanelState>|null}
 */
export function gatePanel(db, job, { now = Date.now(), workerAlive } = {}) {
  let view;
  try { view = jobView(db, job); } catch (error) { if (/no such table/u.test(error.message)) return null; throw error; }
  return view ? gatePanelState(view, now, { workerAlive }) : null;
}

/**
 * Every gate job that reads as stalled, oldest lease first.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: number, workerAlive?: (view: object) => boolean}} [options] - workerAlive says whether a live hand-off worker runs the job.
 * @returns {{id: string, item: number|null, text: string, ageMinutes: number}[]}
 */
export function stalledGates(db, { now = Date.now(), workerAlive } = {}) {
  let rows;
  try { rows = db.prepare("SELECT * FROM job WHERE job_kind = 'gate' AND job_step IN ('queued', 'running') ORDER BY job_lease_until, job_created").all(); }
  catch (error) { if (/no such table/u.test(error.message)) return []; throw error; }
  const stalled = [];
  for (const row of rows) {
    const view = viewOf(row, db.prepare('SELECT * FROM job_step WHERE job_step_job = ? ORDER BY job_step_id').all(row.job_id), text => readPayload(db, text));
    const panel = gatePanelState(view, now, { workerAlive });
    if (panel.stalled) stalled.push({ id: view.id, item: view.item, text: panel.text, ageMinutes: panel.ageMinutes });
  }
  return stalled;
}

/**
 * Every gate job still queued with no lease for longer than a wait, oldest first.
 * Why: doctor names a gate no runner has taken, so a person sees the wait is a missing runner, not a slow gate [C7].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: number, waitMs?: number}} [options]
 * @returns {{id: string, item: number|null, waitedMs: number}[]}
 */
export function unclaimedGateJobs(db, { now = Date.now(), waitMs = 120_000 } = {}) {
  try {
    return db.prepare("SELECT job_id, job_item, job_created FROM job WHERE job_kind = 'gate' AND job_step = 'queued' AND job_lease_owner IS NULL AND job_created <= ? ORDER BY job_created, job_id")
      .all(now - waitMs).map(row => ({ id: row.job_id, item: row.job_item, waitedMs: now - row.job_created }));
  } catch (error) { if (/no such table/u.test(error.message)) return []; throw error; }
}
