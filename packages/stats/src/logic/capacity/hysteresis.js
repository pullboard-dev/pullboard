/** Capacity hysteresis: a computed agent or runner-job count moves only on a sustained, banded change [C7]. */

const HOUR = 3_600_000;
export const HYSTERESIS_BAND = 0.25;
export const HYSTERESIS_HOLD_MS = 2 * HOUR;

/**
 * Settle one computed capacity value against the value currently applied.
 *
 * Why: the planner recomputes every hour from live board data, and applying each result made agent and runner counts
 * flap with the noise. A change is applied only when the computed value differs from the applied one by at least
 * `HYSTERESIS_BAND` in two consecutive hourly windows (same direction), and an applied change is then held
 * `HYSTERESIS_HOLD_MS` before it may change again. Reading twice within one hour keeps the latest reading for that
 * window and never counts as a second window.
 *
 * @param {{ applied: number, since: number, prior: { hour: number, computed: number }|null, current: { hour: number, computed: number } }|null} state
 *   the previous result's `state`, or null on first sight (the first computed value is applied as is).
 * @param {number} computed - the planner's value for this reading.
 * @param {number} now - epoch milliseconds.
 * @returns {{ applied: number, changed: boolean, state: object }} `applied` is the value to use now; pass `state` back next time.
 */
export function settleCapacity(state, computed, now) {
  if (!Number.isFinite(computed)) throw new TypeError('computed capacity must be a finite number');
  const hour = Math.floor(now / HOUR);
  const fresh = { applied: computed, since: now, prior: null, current: { hour, computed } };
  if (!state) return { applied: computed, changed: true, state: fresh };
  const prior = state.current.hour === hour ? state.prior : state.current;
  const current = { hour, computed };
  const moved = value => Math.abs(value - state.applied) >= HYSTERESIS_BAND * Math.max(state.applied, 1);
  const sustained = Boolean(prior) && prior.hour === hour - 1 && moved(prior.computed) && moved(computed)
    && Math.sign(prior.computed - state.applied) === Math.sign(computed - state.applied);
  if (sustained && now - state.since >= HYSTERESIS_HOLD_MS) return { applied: computed, changed: true, state: fresh };
  return { applied: state.applied, changed: false, state: { ...state, prior, current } };
}
