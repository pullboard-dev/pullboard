import { rememberHoldOwner } from "../../../logic/board/holds.js";
import { itemHoldOwner } from "../../../logic/board/holds.js";
import { readBoardMeta } from "../meta.js";
import { writeBoardMeta } from "../meta.js";
import { now } from "../query.js";
import { atomic } from "../event/log.js";
import { coordinatorOnly } from "../../board.js";

const DAY_MS = 86_400_000;
const DONE_KEY = 'hold_owner_upgrade';

/**
 * Give every hold that has no owner record the coordinator and a deadline one day after this upgrade, once per board
 * (#8542). Why: with holds.requireOwner on, a hold made before it has nobody to answer for it, so it would never lapse.
 * Off (default) it does nothing at all, and a second run does nothing, so a hold the coordinator later re-owns stays as set.
 *
 * @param {object} board - The open board.
 * @param {{ agentId: string, requireOwner?: boolean }} options - The acting coordinator and the setting's value as the caller read it.
 * @returns {number[]} The ids of the holds the upgrade gave an owner; empty when it was off or had already run.
 */
export function upgradeHoldOwners(board, { agentId, requireOwner = false }) {
  coordinatorOnly(agentId, 'upgrades holds');
  if (requireOwner !== true) return [];
  return atomic(board, () => {
    if (readBoardMeta(board.db, DONE_KEY) !== undefined) return [];
    const at = now(board);
    const deadline = new Date(Date.parse(at) + DAY_MS).toISOString();
    const upgraded = [];
    for (const { item_id: id } of board.db.prepare('SELECT item_id FROM item WHERE item_hold_reason IS NOT NULL ORDER BY item_id').all()) {
      if (itemHoldOwner(board, id) !== null) continue;
      rememberHoldOwner(board, id, { owner: 'coordinator', deadline });
      upgraded.push(id);
    }
    writeBoardMeta(board.db, DONE_KEY, at);
    return upgraded;
  });
}
