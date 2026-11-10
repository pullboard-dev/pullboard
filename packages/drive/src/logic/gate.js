/** Pure naming and liveness rules for the drive job that runs one submit gate [C7]. */

/** How long after its verdict a driver may still be recording the hand-off result: the lease's 2 minutes. */
const RECORDING_MS = 120_000;

/** The job kind of the drive job a submit gate runs under, kept apart from the 'gate' rows that hold hand-off records. */
export const GATE_DRIVE_KIND = 'gate-drive';

/**
 * The drive job id for one submit hand-off.
 *
 * @param {string} handoff - The hand-off job id (the gate job that holds the record).
 * @returns {string}
 */
export function gateDriveJobId(handoff) {
  return `gate-drive:${handoff}`;
}

/**
 * The worker identity a gate's drive job records, in the shape recovery and the gate wait read: who drives it, the
 * process the dispatcher started, how often it was relaunched, and why it never started when it did not.
 *
 * Why the old shape: recovery's rules (relaunch once, stop a replaced worker by its exact start, end an unstarted
 * gate as infrastructure) stay what they were; only the record moved from worker.json to the job row.
 *
 * @param {string} handoff - The hand-off job id.
 * @param {{ leaseOwner: string | null, leaseUntil: number, step: string, steps: { name: string, payload: any, at: number }[] } | null} view - The drive job's view.
 * @returns {{ version: 1, job: string, owner: string | null, pid: number | null, started: string | null, relaunches: number,
 *   leaseUntil: number, finished: boolean, verdictAt: number | null, unstarted?: { code: string, message: string } } | null} Null before admission.
 */
export function gateDriveRecord(handoff, view) {
  if (!view) return null;
  const admitted = [...view.steps].reverse().find(step => step.name === 'admitted')?.payload ?? {};
  const spawned = [...view.steps].reverse().find(step => step.name === 'spawned' && step.payload.owner === admitted.owner)?.payload ?? null;
  const unstarted = [...view.steps].reverse().find(step => step.name === 'unstarted' && step.payload.owner === admitted.owner)?.payload ?? null;
  const record = { version: 1, job: handoff, owner: admitted.owner ?? null, pid: spawned?.pid ?? null, started: spawned?.started ?? null,
    relaunches: admitted.relaunches ?? 0, leaseUntil: view.leaseUntil, finished: view.step === 'done',
    verdictAt: view.steps.find(step => step.name === 'verdict')?.at ?? null };
  return unstarted ? { ...record, pid: null, started: null, unstarted: { code: unstarted.code, message: unstarted.message } } : record;
}

/**
 * Whether a gate's driver is gone by its job row: it never started, its drive job finished without the hand-off
 * recording a result, or it was admitted and its lease lapsed (it stopped renewing every 5 s for 2 minutes).
 * Why the verdict grace: the verdict frees the drive lease, and the driver then records the hand-off result; a
 * sweep in that moment must not end a gate that is finishing.
 *
 * @param {ReturnType<typeof gateDriveRecord>} record
 * @param {number} now - Epoch milliseconds.
 * @returns {boolean}
 */
export function gateDriverGone(record, now) {
  if (!record) return false;
  if (record.unstarted || record.finished) return true;
  if (record.verdictAt !== null && now - record.verdictAt < RECORDING_MS) return false;
  return record.owner !== null && record.leaseUntil < now;
}

/**
 * Whether a gate's driver ended by its job row alone: it never started, or its drive job finished.
 * Why apart from gateDriverGone: a lapsed lease alone proves only that renewals stopped, and a blocked event loop
 * stops them while the driver lives (#3836); a reader that can see the process judges a lapse by the process.
 *
 * @param {ReturnType<typeof gateDriveRecord>} record
 * @returns {boolean}
 */
export function gateDriverEnded(record) {
  return Boolean(record && (record.unstarted || record.finished));
}

/** How long a live gate drive may go without a step before the sentinel calls it stuck: the drive cell's own stall bound. */
export const GATE_DRIVE_STUCK_MS = 20 * 60_000;

/**
 * The stall of a gate drive whose driver holds a live lease but wrote no step for GATE_DRIVE_STUCK_MS, or null.
 * Why the live lease: a lapsed lease is a gone driver, which gateDriverGone and the health sweep already end; a live
 * one with no step is a driver that renews while it waits, which nothing else names (#2828, 7 Nov).
 *
 * @param {{ id: string, item: number|null, step: string, leaseOwner: string|null, leaseUntil: number, steps: { name: string, at: number }[] } | null} view
 * @param {number} now - Epoch milliseconds.
 * @returns {{ job: string, item: number|null, owner: string, lastStep: string, since: number, idleMs: number } | null}
 */
export function gateDriveStall(view, now) {
  if (!view || !view.leaseOwner || view.leaseUntil < now || view.step === 'done' || !view.steps.length) return null;
  if (view.steps.some(step => step.name === 'verdict')) return null;
  const last = view.steps.reduce((latest, step) => (step.at > latest.at ? step : latest));
  const idleMs = now - last.at;
  return idleMs >= GATE_DRIVE_STUCK_MS ? { job: view.id, item: view.item, owner: view.leaseOwner, lastStep: last.name, since: last.at, idleMs } : null;
}
