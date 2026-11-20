/** Land one accepted item by hand through the landing job's own merge step, and record the reason and the hold it bypassed [C7,#3775]. */
import * as store from '../../../../store/index.js';
import { Refused } from '../../../../kernel/index.js';
import { tryGit } from '../../../../git/index.js';
import { landingEntry } from '../../logic/land/entry.js';
import { testDefectHoldMessage } from '../../logic/land/entry.js';
import { landingMergeArgs } from './merge-args.js';

/**
 * Merge one accepted item onto the branch checked out in `root`, then record it as landed with the reason and the hold.
 *
 * Why: when a trunk test defect holds automatic landing, the coordinator needs one verified path that still merges the
 * way a landing job does (landingMergeArgs: the same --no-ff merge and message) and still leaves the board a record of
 * who went around which hold, instead of an unrecorded `git merge` and a bare `merged`.
 *
 * @param {object} board - The open board.
 * @param {number} id - The accepted item to land.
 * With `exactTreeCheck` on (landing.exactTreeCheck, read by the caller and passed in; never read here), the merged tree must already
 * have a green exact-tree record on the board: without one the merge is undone, the branch stays where it started and the landing
 * is refused naming the tree [V16,V36]. Why: a hand landing is a path to main like any other, and RFC 0011 ET5 has every path pass one check.
 *
 * @param {{ root: string, reason: string, held: Array<{ item?: number, status?: string, test: string }>, agentId: string, exactTreeCheck?: boolean }} options - agentId: the coordinator's seat id; held: the trunk test defects holding automatic landing, as heldTestDefects returns them.
 * @returns {{ id: number, commit: string, reason: string, hold: string }}
 */
export function landOneByHand(board, id, { root, reason, held, agentId, exactTreeCheck = false }) {
  const why = String(reason ?? '').trim();
  if (!why) throw new Refused('HAND_REASON', 'landing by hand names why: pass a reason', 'pullboard land --item <id> --reason "<why>"');
  if (!Array.isArray(held) || !held.length) throw new Refused('NOT_HELD', 'no trunk test defect holds automatic landing, so there is nothing to bypass', 'let the board land the item by itself');
  const item = store.getItem(board, id);
  if (!item || item.item_status !== 'verified' || item.item_merged_commit) throw new Refused('NOT_ACCEPTED', `#${id} is not an accepted item waiting to land`, `pullboard show ${id}`);
  const entry = landingEntry(item);
  const started = tryGit(root, ['rev-parse', 'HEAD']).stdout.trim();
  const merged = tryGit(root, landingMergeArgs(root, entry));
  if (merged.status !== 0) {
    tryGit(root, ['merge', '--abort']);
    throw new Refused('HAND_MERGE_CONFLICT', `#${id} does not merge on the checked-out branch: ${(merged.stdout || merged.stderr).slice(0, 240)}`, `rebase #${id} on main and submit it again`);
  }
  const commit = tryGit(root, ['rev-parse', 'HEAD']).stdout.trim();
  if (exactTreeCheck === true) {
    const tree = tryGit(root, ['rev-parse', `${commit}^{tree}`]).stdout.trim();
    if (!store.landingBatches(board).some(batch => batch.exactTree?.tree === tree && batch.exactTree.result === 'green')) {
      tryGit(root, ['reset', '--keep', started]);
      throw new Refused('LAND_EXACT_TREE', `#${id} would move main to tree ${tree}, which has no green exact-tree record; the branch is back at ${started.slice(0, 12)}`, 'prove that tree with pullboard land, which records the proof before main moves');
    }
  }
  const hold = testDefectHoldMessage(held);
  store.merged(board, id, { agentId, commit, note: `landed by hand: ${why}; bypassed hold: ${hold}` });
  return { id, commit, reason: why, hold };
}
