/** Tell a stalled machine from a dead seat: the pure rule the claim release reads [B4,N2]. */

/** The View runs the claim sweep on this cadence. */
export const SENTINEL_TICK_MS = 10 * 60_000;

/**
 * Whether the claimed seats' silence is the machine stalling. Two or more seats quiet in the same window, and more than
 * half of all claimed seats, is the machine; a single seat that misses alone is a dead seat and is still released.
 *
 * The sentinel's own tick running late (the gap since the previous sweep over twice the ten-minute cadence) also counts,
 * whatever number of seats are quiet.
 *
 * @param {{ claimed: number, quiet: number, gapMs?: number }} seats - How many seats hold claims, how many of them are quiet, and the time since the previous sweep.
 * @returns {{ claimed: number, quiet: number, lateByMs?: number } | null} The counts when the machine stalled, else null.
 */
export function machineStalled({ claimed, quiet, gapMs = 0 }) {
  if (quiet >= 2 && quiet * 2 > claimed) return { claimed, quiet };
  // The sentinel's own tick running late is the machine stalling too: a seat that missed beats in that window is held (#3712).
  return quiet >= 1 && gapMs > 2 * SENTINEL_TICK_MS ? { claimed, quiet, lateByMs: gapMs - SENTINEL_TICK_MS } : null;
}
