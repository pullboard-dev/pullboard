/**
 * What a pulled gate's receipt tells its reader, in the shape the inline gate returned on submit: the test plan (files,
 * testTiers, phasePlan, check), the counts, the full log and the proof receipts the board recorded for it [P7,C7].
 * Why one reader: `show --json`, the settled submit and the red summary read the same receipt; a 0.9.3 receipt without
 * these fields reads as absent, so it never crashes a reader or fails a replay.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

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
