/** Pure self-tuning of the census job length from the last census's shard wall times [C7,U151]. */

/** Budget: fewer measured shards than this say too little about job length, so no tuned value is given. */
export const SELF_TUNE_MIN_SHARDS = 4;
/** Budget: the tuned length never goes below this many minutes, so one quick census cannot cut jobs to slivers. */
export const SELF_TUNE_FLOOR_MINUTES = 3;
/** Budget: the tuned length never goes above this many minutes, the runner's per-job ceiling. */
export const SELF_TUNE_CEIL_MINUTES = 20;

/**
 * The census job length, in whole minutes, that the last census's shard times suggest: the 80th percentile (nearest rank)
 * of shard wall time, rounded to a minute and kept between floor and ceil. Null for fewer than four usable times. Why the
 * percentile: it ignores the order the times arrive in, and one extreme shard can move the answer only as far as the clamp.
 *
 * @param {number[]} shardMs - Wall time of each shard in milliseconds; non-finite and non-positive entries are ignored.
 * @param {{ floor?: number, ceil?: number }} [clamp]
 * @returns {number | null}
 */
export function selfTunedJobMinutes(shardMs, { floor = SELF_TUNE_FLOOR_MINUTES, ceil = SELF_TUNE_CEIL_MINUTES } = {}) {
  const times = (Array.isArray(shardMs) ? shardMs : []).filter(ms => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
  if (times.length < SELF_TUNE_MIN_SHARDS) return null;
  const p80 = times[Math.ceil(0.8 * times.length) - 1];
  return Math.min(ceil, Math.max(floor, Math.round(p80 / 60_000)));
}
