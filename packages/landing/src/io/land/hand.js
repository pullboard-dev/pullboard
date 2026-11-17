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
 * @param {{ root: string, reason: string, held: Array<{ item?: number, status?: string, test: string }>, agentId: string }} options - agentId: the coordinator's seat id; held: the trunk test defects holding automatic landing, as heldTestDefects returns them.
 * @returns {{ id: number, commit: string, reason: string, hold: string }}
 */
export function landOneByHand(board, id, { root, reason, held, agentId }) {
  const why = String(reason ?? '').trim();
  if (!why) throw new Refused('HAND_REASON', 'landing by hand names why: pass a reason', 'pullboard land --item <id> --reason "<why>"');
  if (!Array.isArray(held) || !held.length) throw new Refused('NOT_HELD', 'no trunk test defect holds automatic landing, so there is nothing to bypass', 'let the board land the item by itself');
  const item = store.getItem(board, id);
  if (!item || item.item_status !== 'verified' || item.item_merged_commit) throw new Refused('NOT_ACCEPTED', `#${id} is not an accepted item waiting to land`, `pullboard show ${id}`);
  const entry = landingEntry(item);
  const merged = tryGit(root, landingMergeArgs(root, entry));
  if (merged.status !== 0) {
    tryGit(root, ['merge', '--abort']);
    throw new Refused('HAND_MERGE_CONFLICT', `#${id} does not merge on the checked-out branch: ${(merged.stdout || merged.stderr).slice(0, 240)}`, `rebase #${id} on main and submit it again`);
  }
  const commit = tryGit(root, ['rev-parse', 'HEAD']).stdout.trim();
  const hold = testDefectHoldMessage(held);
  store.merged(board, id, { agentId, commit, note: `landed by hand: ${why}; bypassed hold: ${hold}` });
  return { id, commit, reason: why, hold };
}
