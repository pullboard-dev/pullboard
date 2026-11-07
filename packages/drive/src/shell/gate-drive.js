/** The drive job a submit gate runs under: admission by the dispatcher, the started process, and its record [C7]. */
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { releaseLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { Refused } from '../../../kernel/index.js';
import { GATE_DRIVE_KIND } from '../core/gate-drive.js';
import { gateDriveJobId } from '../core/gate-drive.js';
import { gateDriveRecord } from '../core/gate-drive.js';

/**
 * The count of steps with this name already on the job, the seq the next one takes.
 *
 * @param {ReturnType<typeof jobView>} view
 * @param {string} name
 * @returns {number}
 */
function nextSeq(view, name) {
  return view.steps.filter(step => step.name === name).length;
}

/**
 * Admit one queued gate to a driver: create its drive job, take the lease for `owner` and write an `admitted` step.
 * The dispatcher calls this before it starts the driver process, so the gate is never without a record of who
 * drives it, even before the process exists.
 *
 * Why before the start: the dispatcher removes the gate's place in line once it starts, and a gate with neither a
 * place nor a driver record reads as lost (#3121, #3153).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} handoff - The hand-off job id.
 * @param {{ owner: string, relaunches?: number, now?: number }} options
 * @returns {ReturnType<typeof gateDriveRecord>}
 */
export function admitGateDrive(db, handoff, { owner, relaunches = 0, now = Date.now() }) {
  const id = gateDriveJobId(handoff);
  createJob(db, { id, kind: GATE_DRIVE_KIND, now });
  const take = takeJob(db, id, owner, { now });
  if (!take.taken) throw new Refused('GATE_DRIVE_LEASED', `gate ${handoff} already has a live driver (${take.job.leaseOwner}); leave it to finish`);
  writeStep(db, id, 'admitted', { owner, relaunches }, { seq: nextSeq(take.job, 'admitted'), now });
  return readGateDrive(db, handoff);
}

/**
 * Record the driver process the dispatcher started for an admitted gate: its pid and exact start, so recovery can
 * stop exactly that process when a newer head replaces the gate.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} handoff
 * @param {{ owner: string, pid: number, started: string, now?: number }} options
 */
export function recordGateDriveSpawn(db, handoff, { owner, pid, started, now = Date.now() }) {
  const view = jobView(db, gateDriveJobId(handoff));
  if (!view) throw new Refused('JOB_MISSING', `gate ${handoff} was never admitted: admit it before recording its driver`);
  writeStep(db, view.id, 'spawned', { owner, pid, started }, { seq: nextSeq(view, 'spawned'), now });
}

/**
 * End an admitted gate whose driver could not start: write an `unstarted` step with the reason and free the lease,
 * so the health sweep ends the gate as infrastructure, never a builder red (#3121).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} handoff
 * @param {{ owner: string, code: string, message: string, now?: number }} options
 */
export function endGateDriveUnstarted(db, handoff, { owner, code, message, now = Date.now() }) {
  const id = gateDriveJobId(handoff);
  createJob(db, { id, kind: GATE_DRIVE_KIND, now });
  const view = jobView(db, id);
  writeStep(db, id, 'unstarted', { owner, code, message }, { seq: nextSeq(view, 'unstarted'), now });
  releaseLease(db, id, owner, { now });
}

/**
 * The gate's driver record from its drive job, or null when no driver was ever admitted.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} handoff
 * @returns {ReturnType<typeof gateDriveRecord>}
 */
export function readGateDrive(db, handoff) {
  let view;
  try { view = jobView(db, gateDriveJobId(handoff)); }
  catch (error) { if (/no such table/u.test(error.message)) return null; throw error; }
  return gateDriveRecord(handoff, view);
}
