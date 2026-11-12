import { requireOutsideOwner } from "../../../../items/index.js";
import { itemById } from "./query.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { Refused } from "../../../../kernel/index.js";
import { coordinatorOnly } from "../board.js";
import { setItem } from "../board.js";
import { withdraw } from "./withdraw.js";
import { FORCED_MERGE_ENGINE } from "../../../../state/index.js";

/**
 * Record the commit a verified item landed as on the main line, e.g. after a squash merge.
 *
 * @param {any} board
 * @param {number} id
 * A forced merge (`forced` is the reason) records work landed around the gate at a commit, even when the item was open or
 * withdrawn as met; its event is marked forced, and a withdrawn item with a merged event reads as landed on the board and /live.
 * Why: hand landings were withdrawn as met, which /live and stats do not count [C7].
 *
 * @param {{ agentId: string, commit: string, note?: string, forced?: string }} merge
 */
export function merged(board, id, { agentId, commit, note = '', flakeRatchet, forced }) {
  coordinatorOnly(agentId, 'records merges');
  const reason = typeof forced === 'string' ? forced.trim() : '';
  if (forced !== undefined && !reason) throw new Refused('FORCED_REASON', 'a forced merge names why it went around the gate: --forced "<why>"');
  if (reason && (board.executionEngineVersion !== undefined && board.executionEngineVersion < FORCED_MERGE_ENGINE)) {
    throw new Refused('ENGINE_VERSION', `a forced merge requires engine ${FORCED_MERGE_ENGINE}; upgrade Pullboard before recording one`);
  }
  atomic(board, () => {
    const item = itemById(board, id);
    // A second merge writes nothing for the same commit and refuses for another, so a landing is recorded once.
    if (item.item_merged_commit) {
      if (item.item_merged_commit === commit) return;
      throw new Refused('ALREADY_MERGED', `item #${id} was merged as ${item.item_merged_commit}; it cannot be merged again as ${commit}`);
    }
    if (!reason && item.item_status !== 'verified') {
      throw new Refused('NOT_VERIFIED', `item #${id} is ${item.item_status}; merge verified work only`);
    }
    if (!reason) requireOutsideOwner(board, item);
    // A forced landing closes an unfinished item by the ordinary withdraw move; the merged event then reads it as landed.
    if (reason && ['open', 'claimed', 'submitted'].includes(item.item_status)) {
      withdraw(board, id, { agentId, reason: `landed by hand at ${commit.slice(0, 12)}: ${reason}` });
    }
    setItem(board, id, { item_merged_commit: commit });
    logEvent(board, agentId, 'merged', id, { commit, ...(note.trim() ? { note: note.trim() } : {}),
      ...(reason ? { forced: true, reason, from: item.item_status } : {}),
      ...(flakeRatchet === undefined ? {} : { flakeRatchet }) });
  });
}
