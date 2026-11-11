/** Split a test run's selected files across free runner slots by recorded per-file time [C7]. */
import { planLandingShards } from './shards.js';

/**
 * Plan the shards of one test run: the selected files split across the free runner slots, balanced
 * by each file's last recorded wall time (file count where none is recorded).
 * Why: it never takes more shards than there are free slots and never more than files, and with
 * one free slot (or one file) it returns a single shard holding every file in today's order, so a
 * run with no spare capacity is unchanged. A pure function: nothing reads or reserves a slot here.
 *
 * @param {string[]} files - The selected test files, in the order today's run uses.
 * @param {number} freeSlots - Free runner slots right now.
 * @param {Record<string, number>} [times] - Last wall time in ms by repository-relative path.
 * @param {string|null} [root] - Repository root, so absolute and relative spellings dedupe.
 * @returns {{ files: string[], weight: number }[]}
 */
export function planRunShards(files, freeSlots, times = {}, root = null) {
  const slots = Number.isInteger(freeSlots) ? Math.max(1, freeSlots) : 1;
  if (slots === 1 || files.length < 2) return [{ files: [...files], weight: files.length }];
  return planLandingShards(files, Math.min(slots, files.length), times, root);
}

/**
 * Decide how an ordinary (build, submit or review) test run splits across the runner slots free right now.
 * Why: a landing keeps its own fan-out and goes first in the queue, a shard of a run and a run already inside a runner
 * slot never split again, and `freeSlots` is read after the landings' holders and waiters, so a run takes only the
 * slots free once landings have theirs. Any of those cases, or one free slot, gives today's single pass.
 *
 * @param {{ files: string[], freeSlots: number, times?: Record<string, number>, root?: string|null,
 *   landing?: boolean, shard?: boolean, insideRunnerSlot?: boolean }} run
 * @returns {{ files: string[], weight: number }[]} One entry per shard; a single entry means no split.
 */
export function ordinaryRunShards({ files, freeSlots, times = {}, root = null, landing = false, shard = false, insideRunnerSlot = false }) {
  if (landing || shard || insideRunnerSlot) return [{ files: [...files], weight: files.length }];
  return planRunShards(files, freeSlots, times, root);
}
