/** Tell a stalled machine from a dead seat: the pure rule the claim release reads [B4,N2]. */

/**
 * Whether the claimed seats' silence is the machine stalling. Two or more seats quiet in the same window, and more than
 * half of all claimed seats, is the machine; a single seat that misses alone is a dead seat and is still released.
 *
 * @param {{ claimed: number, quiet: number }} seats - How many seats hold claims, and how many of them are quiet.
 * @returns {{ claimed: number, quiet: number } | null} The counts when the machine stalled, else null.
 */
export function machineStalled({ claimed, quiet }) {
  return quiet >= 2 && quiet * 2 > claimed ? { claimed, quiet } : null;
}
