/** The cycle clock: when the line controller may retune, from landings, elapsed time and the oldest wait [C7,#1099]. */
const HOUR = 3_600_000;
export const TUNE_LANDED = 8;
export const TUNE_FLOOR_MS = HOUR;
export const TUNE_CEILING_MS = 7 * 24 * HOUR;
export const TUNE_BREACH_FACTOR = 3;

/**
 * Decide whether the line may be retuned now: a wait over three times its target is due at once (breach);
 * otherwise eight landings after at least an hour is due (cycle), seven days is due with fewer (ceiling),
 * and anything else is not due, with floor naming the hour that has not yet passed.
 */
export function tuneCycleDue({ landedSinceChange, lastChangeAt, oldestWait }, now) {
  const wait = oldestWait;
  if (wait && wait.targetMinutes > 0 && wait.minutes > TUNE_BREACH_FACTOR * wait.targetMinutes) {
    return { due: true, reason: 'breach' };
  }
  const elapsed = now - lastChangeAt;
  if (elapsed >= TUNE_CEILING_MS) return { due: true, reason: 'ceiling' };
  if (landedSinceChange >= TUNE_LANDED) {
    return elapsed >= TUNE_FLOOR_MS ? { due: true, reason: 'cycle' } : { due: false, reason: 'floor' };
  }
  return { due: false, reason: 'cycle' };
}
