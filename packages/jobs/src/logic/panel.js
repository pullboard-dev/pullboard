/** Pure rules for how a gate job reads on the gate panel of `show` and `status` [C7]. */
import { leaseLapsed } from "./rules.js";

/**
 * Whole minutes between two instants, never negative.
 *
 * @param {number} from - Epoch milliseconds.
 * @param {number} now - Epoch milliseconds.
 * @returns {number}
 */
function minutesBetween(from, now) {
  return Math.max(0, Math.floor((now - from) / 60_000));
}

/**
 * Say how a gate job reads right now.
 *
 * Why: a job showing `running` with no live lease is a ghost nobody drives; it must read "stalled (reclaimable)"
 * with its age, never "running". A queued job nobody has taken is only waiting, so it stays `queued`. Any other step
 * is a finished or failed state and is shown as written.
 *
 * A lease-free row (never taken, as the shadow mirror writes them until the drive worker owns the lease) is stalled only
 * when no live hand-off worker runs it; a row that holds a lease is stalled exactly when that lease has lapsed.
 *
 * @param {{id?: string, step: string, leaseOwner: string|null, leaseUntil: number, updated: number}} view - A job view.
 * @param {number} now - Epoch milliseconds.
 * @param {{workerAlive?: (view: object) => boolean}} [options] - workerAlive says whether a live hand-off worker runs this job; used for lease-free rows only.
 * @returns {{state: string, stalled: boolean, ageMinutes: number, text: string}}
 */
export function gatePanelState(view, now, { workerAlive } = {}) {
  const live = view.step === 'running' || (view.step === 'queued' && view.leaseOwner !== null);
  const leaseFree = view.leaseOwner === null && !(view.leaseUntil > 0);
  const driven = leaseFree && typeof workerAlive === 'function' && workerAlive(view) === true;
  if (live && !driven && leaseLapsed(view.leaseUntil, now)) {
    const ageMinutes = minutesBetween(view.leaseUntil > 0 ? view.leaseUntil : view.updated, now);
    return { state: 'stalled', stalled: true, ageMinutes, text: `stalled (reclaimable) ${ageMinutes}m` };
  }
  return { state: view.step, stalled: false, ageMinutes: 0, text: view.step };
}
