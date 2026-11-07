/** Read the gate panel for one gate job or for every stalled one [C7]. */
import { jobView } from "./job-store.js";
import { viewOf } from "../core/job-view.js";
import { gatePanelState } from "../core/gate-panel.js";

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
    const view = viewOf(row, db.prepare('SELECT * FROM job_step WHERE job_step_job = ? ORDER BY job_step_id').all(row.job_id));
    const panel = gatePanelState(view, now, { workerAlive });
    if (panel.stalled) stalled.push({ id: view.id, item: view.item, text: panel.text, ageMinutes: panel.ageMinutes });
  }
  return stalled;
}
