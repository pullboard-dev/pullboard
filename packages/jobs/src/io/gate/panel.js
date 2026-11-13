/**
 * Read the gate panel for one gate job or for every stalled one [C7], and what a pulled gate's receipt tells its reader [P7,C7]:
 * `show --json`, the settled submit and the red summary read the same receipt. Why one file: it is loaded by every command that
 * reads the jobs front door, so a second file would add a module to every closure.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
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

/** A kept log is named by the runner inside its run's folder: one plain file name, never a path. */
const KEPT_NAME = /^[\w.-]+$/u;
/** The gate job phases the board records as the item's proof receipts, in submit order (criterion, then proof). */
const RECORDED_ROLES = ['check', 'proof'];

/**
 * The id of the proof receipt the board records for one phase of one gate job. Why derived: a reader finds the receipts
 * of exactly this gate among the item's receipts without a second record, and a job's phase is recorded at most once.
 *
 * @param {string} job
 * @param {string} role - The gate job phase: check or proof.
 * @returns {string} A 36-character receipt id.
 */
export function phaseReceiptId(job, role) {
  const hex = createHash('sha256').update(`pullboard gate phase receipt\0${job}\0${role}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** Sum the phases' runner counts; a count any phase did not print stays unknown (null), and no counts at all is null. */
function gateCounts(phases) {
  const rows = phases.map(phase => phase.counts).filter(row => row && typeof row === 'object');
  if (!rows.length) return null;
  const sum = key => rows.every(row => Number.isSafeInteger(row[key])) ? rows.reduce((total, row) => total + row[key], 0) : null;
  return { passed: sum('passed'), failed: sum('failed'), skipped: sum('skipped') };
}

/**
 * The gate a posted gate-job receipt records, with the fields the inline gate returned added from what it carries:
 * counts summed over its phases; logPath, the kept log of its first red phase (else its last phase) inside the run's
 * output folder on runner logRunner; and, from its plan, files, testTiers, phasePlan, check and proofReceiptIds (the
 * receipts the board recorded for this job, among `recorded`). A field the receipt does not carry is left out.
 *
 * @param {string} job - The gate job id.
 * @param {{ runner?: string, receipt?: Record<string, any> } | null} posted - The job's receipt step payload.
 * @param {Set<string>} [recorded] - The item's recorded proof receipt ids.
 * @returns {Record<string, any> | null}
 */
export function settledGate(job, posted, recorded = new Set()) {
  const gate = posted?.receipt?.gate;
  if (!gate || typeof gate !== 'object' || Array.isArray(gate)) return gate ?? null;
  const phases = Array.isArray(gate.phases) ? gate.phases.filter(phase => phase && typeof phase === 'object') : [];
  const counts = gateCounts(phases);
  const kept = phase => typeof phase.kept === 'string' && KEPT_NAME.test(phase.kept);
  const logged = phases.find(phase => phase.status !== 0 && kept(phase)) ?? phases.findLast(kept);
  const output = posted.receipt.output, folder = typeof output?.folder === 'string' && output.folder ? output.folder : null;
  const plan = gate.plan && typeof gate.plan === 'object' && !Array.isArray(gate.plan) ? gate.plan : null;
  const phasePlan = Array.isArray(plan?.phasePlan) ? plan.phasePlan : [];
  const check = phases.find(phase => phase.role === 'check');
  const steps = gate.steps && typeof gate.steps === 'object' ? gate.steps : {};
  return { ...gate, ...(counts ? { counts } : {}),
    ...(logged && folder ? { logPath: join(folder, logged.kept), logRunner: output.runner ?? posted.runner ?? null } : {}),
    ...(plan ? { files: Array.isArray(plan.files) ? plan.files : [], testTiers: plan.testTiers ?? null, phasePlan,
      check: { command: phasePlan.find(phase => phase.role === 'criterion')?.command ?? null, checked: Boolean(check), green: check ? check.status === 0 : null },
      profile: { wallMs: Object.values(steps).reduce((total, ms) => total + (Number.isSafeInteger(ms) ? ms : 0), 0), steps },
      proofReceiptIds: RECORDED_ROLES.map(role => phaseReceiptId(job, role)).filter(id => recorded.has(id)) } : {}) };
}
