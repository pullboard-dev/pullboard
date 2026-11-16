/** Pure self-tuning of the push gate's shard target time from the last pushes' recorded shard times [C7,U151,#9372]. */

/** Budget: fewer recorded pushes than this say too little, so the default target stands. */
export const PUSH_TUNE_MIN_PUSHES = 3;
/** Budget: the target never goes below 2 minutes, so a quick run of pushes cannot cut shards to slivers. */
export const PUSH_TUNE_MIN_MS = 2 * 60_000;
/** Budget: the target never goes above 20 minutes, the runner's per-job ceiling. */
export const PUSH_TUNE_MAX_MS = 20 * 60_000;
/** A step changes the target by a quarter, the board's #6617 hysteresis rule: one step per decision, never a jump. */
const STEP = 0.25;

/** The slowest shard of one recorded push in ms, or null when the row records no shard time. */
function slowestShard(push) {
  const times = (Array.isArray(push?.parts) ? push.parts : []).map(part => part?.wallMs).filter(ms => Number.isFinite(ms) && ms >= 0);
  return times.length ? Math.max(...times) : null;
}

/**
 * The shard target time to plan the next push with: defaultMs, lowered by a quarter when the slowest shard ran over 1.5 times
 * the target in each of the last 3 pushes, raised by a quarter when every shard stayed under half the target in each of them,
 * else defaultMs; always within 2 to 20 minutes. Fewer than 3 usable pushes give defaultMs. Why a quarter and the last 3:
 * a single slow push is noise, and a target that jumps would flap the shard count push to push [U151].
 *
 * @param {{ at?: string, parts?: { wallMs: number | null }[] }[]} history - Recorded push.timing rows, in any order.
 * @param {number} defaultMs - The target in force with no history.
 * @returns {number}
 */
export function tunedTargetMs(history, defaultMs) {
  const clamp = ms => Math.min(PUSH_TUNE_MAX_MS, Math.max(PUSH_TUNE_MIN_MS, Math.round(ms)));
  const base = Number.isFinite(defaultMs) && defaultMs > 0 ? clamp(defaultMs) : PUSH_TUNE_MIN_MS;
  const recent = (Array.isArray(history) ? history : [])
    .map(push => ({ at: String(push?.at ?? ''), slowest: slowestShard(push) }))
    .filter(push => push.slowest !== null)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, PUSH_TUNE_MIN_PUSHES);
  if (recent.length < PUSH_TUNE_MIN_PUSHES) return base;
  if (recent.every(push => push.slowest > base * 1.5)) return clamp(base * (1 - STEP));
  if (recent.every(push => push.slowest < base * 0.5)) return clamp(base * (1 + STEP));
  return base;
}
