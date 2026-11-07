/** Pure rules for how a gate job reads on the gate panel of `show` and `status` [C7]. */
import { leaseLapsed } from "./lease-rules.js";

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
 * @param {{step: string, leaseOwner: string|null, leaseUntil: number, updated: number}} view - A job view.
 * @param {number} now - Epoch milliseconds.
 * @returns {{state: string, stalled: boolean, ageMinutes: number, text: string}}
 */
export function gatePanelState(view, now) {
  const live = view.step === 'running' || (view.step === 'queued' && view.leaseOwner !== null);
  if (live && leaseLapsed(view.leaseUntil, now)) {
    const ageMinutes = minutesBetween(view.leaseUntil > 0 ? view.leaseUntil : view.updated, now);
    return { state: 'stalled', stalled: true, ageMinutes, text: `stalled (reclaimable) ${ageMinutes}m` };
  }
  return { state: view.step, stalled: false, ageMinutes: 0, text: view.step };
}
