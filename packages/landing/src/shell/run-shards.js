/** Split a test run's selected files across free runner slots by recorded per-file time [C7]. */
import { planLandingShards } from './landing-shards.js';

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
