/** The drive job a submit gate runs under: admission by the dispatcher, the started process, and its record [C7]. */
import { createJob } from '../../../jobs/index.js';
import { jobView } from '../../../jobs/index.js';
import { releaseLease } from '../../../jobs/index.js';
import { takeJob } from '../../../jobs/index.js';
import { writeStep } from '../../../jobs/index.js';
import { Refused } from '../../../kernel/index.js';
import { GATE_DRIVE_KIND } from '../logic/gate.js';
import { gateDriveJobId } from '../logic/gate.js';
import { gateDriveRecord } from '../logic/gate.js';
import { gateDriveStall } from '../logic/gate.js';
import { leasedJobs } from '../../../jobs/index.js';

/**
 * @typedef {object} GateHopPort
 * @property {boolean} enabled - gate.fencedHop, read by the caller.
 * @property {number} item - The item whose hop this gate drives.
 * @property {Function} write - The store's gateHopMove.
 * @property {Function} decide - The hop table's decision over the read row and the move.
 */

/**
 * Move the item's fenced hop row for one gate driver: the caller hands in the row writer, the hop table's decision and the
 * gate.fencedHop setting, so the drive cell reads no settings and imports neither the store nor the moves cell. With the
 * setting off it does nothing. A hop held by another live driver is refused HOP_FENCED, naming that driver [C7,#8274].
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {GateHopPort | undefined} hop
 * @param {{ name: 'acquire' | 'step', actor: string, epoch?: number }} move
 * @returns {{ off: true } | { hop: { owner: string | null, epoch: number } }}
 */
function moveHop(db, hop, move) {
  if (hop?.enabled !== true) return { off: true };
  const write = decide => hop.write(db, { item: hop.item, actor: move.actor, enabled: true, decide });
  try {
    if (move.name !== 'acquire') return write(row => hop.decide(row, move));
    // A first driver finds no row: the table creates the queued hop, then the same driver acquires it.
    let created = false;
    const first = write(row => { if (row) return hop.decide(row, move); created = true; return hop.decide(null, { name: 'create', actor: move.actor }); });
    return created ? write(row => hop.decide(row, move)) : first;
  } catch (error) {
    if (error.code === 'HOP_HELD') throw new Refused('HOP_FENCED', error.message, 'stop driving: another driver owns the hop; acquire it again if its lease lapses');
    throw error;
  }
}

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
 * @param {{ owner: string, relaunches?: number, now?: number, hop?: GateHopPort, runs?: { db: import('node:sqlite').DatabaseSync } | null }} options - runs: the board's runs holder while runs_store is on; the drive job's rows go there, and the hop stays on `db` [P7,#9080].
 * @returns {ReturnType<typeof gateDriveRecord>}
 */
export function admitGateDrive(db, handoff, { owner, relaunches = 0, now = Date.now(), hop, runs = null }) {
  const id = gateDriveJobId(handoff);
  const jobs = runs?.db ?? db;
  createJob(jobs, { id, kind: GATE_DRIVE_KIND, now });
  const take = takeJob(jobs, id, owner, { now });
  if (!take.taken) throw new Refused('GATE_DRIVE_LEASED', `gate ${handoff} already has a live driver (${take.job.leaseOwner}); leave it to finish`);
  let acquired;
  try { acquired = moveHop(db, hop, { name: 'acquire', actor: owner }); }
  catch (error) { releaseLease(jobs, id, owner, { now }); throw error; }
  writeStep(jobs, id, 'admitted', { owner, relaunches, ...(acquired.hop ? { hopEpoch: acquired.hop.epoch } : {}) }, { seq: nextSeq(take.job, 'admitted'), now });
  return readGateDrive(db, handoff, { runs });
}

/**
 * Renew a gate driver's hop through the fenced row at the epoch it acquired, so a driver whose hop lapsed and was taken is refused HOP_FENCED.
 * With gate.fencedHop off it renews nothing and answers `{ off: true }`.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} handoff - The hand-off job id.
 * @param {{ owner: string, hop?: GateHopPort, runs?: { db: import('node:sqlite').DatabaseSync } | null }} options
 * @returns {ReturnType<typeof moveHop>}
 */
export function renewGateDriveHop(db, handoff, { owner, hop, runs = null }) {
  if (hop?.enabled !== true) return { off: true };
  const steps = jobView(runs?.db ?? db, gateDriveJobId(handoff))?.steps ?? [];
  const epoch = [...steps].reverse().find(step => step.name === 'admitted' && step.payload.owner === owner)?.payload.hopEpoch;
  return moveHop(db, hop, { name: 'step', actor: owner, epoch });
}

/**
 * Record the driver process the dispatcher started for an admitted gate: its pid and exact start, so recovery can
 * stop exactly that process when a newer head replaces the gate.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} handoff
 * @param {{ owner: string, pid: number, started: string, now?: number, runs?: { db: import('node:sqlite').DatabaseSync } | null }} options
 */
export function recordGateDriveSpawn(db, handoff, { owner, pid, started, now = Date.now(), runs = null }) {
  const jobs = runs?.db ?? db;
  const view = jobView(jobs, gateDriveJobId(handoff));
  if (!view) throw new Refused('JOB_MISSING', `gate ${handoff} was never admitted: admit it before recording its driver`);
  writeStep(jobs, view.id, 'spawned', { owner, pid, started }, { seq: nextSeq(view, 'spawned'), now });
}

/**
 * End an admitted gate whose driver could not start: write an `unstarted` step with the reason and free the lease,
 * so the health sweep ends the gate as infrastructure, never a builder red (#3121).
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} handoff
 * @param {{ owner: string, code: string, message: string, now?: number, runs?: { db: import('node:sqlite').DatabaseSync } | null }} options
 */
export function endGateDriveUnstarted(db, handoff, { owner, code, message, now = Date.now(), runs = null }) {
  const id = gateDriveJobId(handoff);
  const jobs = runs?.db ?? db;
  createJob(jobs, { id, kind: GATE_DRIVE_KIND, now });
  const view = jobView(jobs, id);
  writeStep(jobs, id, 'unstarted', { owner, code, message }, { seq: nextSeq(view, 'unstarted'), now });
  releaseLease(jobs, id, owner, { now });
}

/**
 * The gate's driver record from its drive job, or null when no driver was ever admitted.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} handoff
 * @param {{ runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options]
 * @returns {ReturnType<typeof gateDriveRecord>}
 */
export function readGateDrive(db, handoff, { runs = null } = {}) {
  let view;
  try { view = jobView(runs?.db ?? db, gateDriveJobId(handoff)); }
  catch (error) { if (/no such table/u.test(error.message)) return null; throw error; }
  return gateDriveRecord(handoff, view);
}

/**
 * Health findings for every gate drive that renews its lease but wrote no step for 20 minutes: one Stuck notice per
 * drive job, naming its item and job. The sentinel's health scan reads these, so the coordinator hears of a hung gate
 * the same hour, while the drive cell ends and retries it on its own.
 *
 * @param {import('node:sqlite').DatabaseSync} db - The board's SQLite handle, read only.
 * @param {Date} now
 * @param {{ runs?: { db: import('node:sqlite').DatabaseSync } | null }} [options]
 * @returns {{ key: string, cause: string, item: number|null, subject: string, title: string, since: string, ageMinutes: number,
 *   why: string, next: string, command: null, owner: { role: 'coordinator', who: 'coordinator' }, detail: object }[]}
 */
export function stalledGateDriveFindings(db, now, { runs = null } = {}) {
  const at = now.getTime();
  let views;
  try { views = leasedJobs(runs?.db ?? db, { kind: GATE_DRIVE_KIND, now: at }); }
  catch (error) { if (/no such table/u.test(error.message)) return []; throw error; }
  return views.map(view => gateDriveStall(view, at)).filter(Boolean).map(stall => {
    const minutes = Math.floor(stall.idleMs / 60_000);
    return { key: `GATE_DRIVE_STALLED:job:${stall.job}`, cause: 'GATE_DRIVE_STALLED', item: stall.item,
      subject: stall.item ? `#${stall.item}` : `job ${stall.job}`, title: 'gate drive renews its lease with no step',
      since: new Date(stall.since).toISOString(), ageMinutes: minutes,
      why: `gate drive job ${stall.job} (driver ${stall.owner}) wrote no step for ${minutes} min after ${stall.lastStep}, while its lease stays live`,
      next: `read the gate's worker.log for #${stall.item ?? '?'}; the drive cell ends and reruns a stalled gate once, then ends it as infrastructure`,
      command: null, owner: { role: 'coordinator', who: 'coordinator' }, detail: { job: stall.job, driver: stall.owner, lastStep: stall.lastStep } };
  });
}
