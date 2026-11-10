import { getItem } from "./query.js";
import { COORDINATOR } from "../../../../config/index.js";
import { Refused } from "../../../../kernel/index.js";
import { setItem } from "../board.js";

/** Link a fresh neutral CI repair to its merged original without changing either status [B2,R3]. */
export function linkPublishRepair(board, { agentId, item, repair }) {
  if (agentId !== COORDINATOR) throw new Refused('COORDINATOR_ONLY', 'only the coordinator links publication CI repairs');
  const original = getItem(board, item);
  const child = getItem(board, repair);
  if (!original.item_merged_commit || original.item_status !== 'verified' || child.item_status !== 'open' ||
      child.item_created_by !== COORDINATOR || child.item_parent_id !== null || child.item_lane !== original.item_lane || item === repair) {
    throw new Refused('PUBLISH_FINDING', 'link only a new neutral coordinator repair to its merged original');
  }
  setItem(board, repair, { item_parent_id: item });
}
