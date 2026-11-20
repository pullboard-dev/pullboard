import { Refused } from "../../../../kernel/index.js";
import { BLOCK_ENGINE } from "../board.js";
import { ENGINE_VERSION } from "../board.js";
import { newBlock } from "../../../../items/index.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { now } from "./query.js";
import { writeBoardMeta } from "./meta.js";
import { listBoardMetaWithPrefix } from "./meta.js";

/** The board_meta key prefix one block record lives under, keyed by the block name. */
const BLOCK_PREFIX = "block:";

/**
 * Record a named block of items: its name, member ids and tier, the actor and the board clock reading [C7,#2202].
 * Why the record sits in board_meta: a block has no item row, and every replica replays the same value from the event [C7,#11280].
 *
 * @param {any} board
 * @param {{ agentId: string, name: string, ids: number[], tier: string }} options
 * @returns {{ name: string, ids: number[], tier: string, by: string, at: string, members: number[] }}
 */
export function addBlock(board, { agentId, name, ids, tier }) {
  if ((board.executionEngineVersion ?? ENGINE_VERSION) < BLOCK_ENGINE) {
    throw new Refused("ENGINE_VERSION", "blocks require replay-aware writers; upgrade every linked device");
  }
  const block = newBlock(name, ids, tier);
  return atomic(board, () => {
    if (board.db.prepare("SELECT 1 FROM board_meta WHERE meta_key = ?").get(BLOCK_PREFIX + block.name)) {
      throw new Refused("BLOCK_EXISTS", `a block named ${block.name} already exists`);
    }
    for (const id of block.ids) {
      if (!board.db.prepare("SELECT 1 FROM item WHERE item_id = ?").get(id)) throw new Refused("NO_ITEM", `item #${id} does not exist; a block names items on this board`);
    }
    const record = { ...block, by: agentId, at: now(board) };
    writeBoardMeta(board.db, BLOCK_PREFIX + block.name, JSON.stringify(record));
    logEvent(board, agentId, "add_block", null, { name: block.name, ids: block.ids, tier: block.tier });
    return { ...record, members: [...record.ids] };
  });
}

/** Every recorded block in name order, each with its members. */
export function listBlocks(board) {
  return listBoardMetaWithPrefix(board.db, BLOCK_PREFIX).map(row => {
    const record = JSON.parse(row.value);
    return { ...record, members: [...record.ids] };
  });
}
