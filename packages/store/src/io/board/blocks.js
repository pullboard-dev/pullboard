import { Refused } from "../../../../kernel/index.js";
import { claim } from "../board.js";
import { canTake } from "../board.js";
import { routeOf } from "../board.js";
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

/**
 * Claim every open member of a named block for one seat with every refusal checked before the first claim, or none of them [C7,#2202].
 * Why: each member takes the ordinary claim and the same lease, so one clock reading serves the whole block; members keep their own criteria and verdicts.
 * Members are item-folder claims sized to the whole block (ten live claims at most), so the one-top-level-claim rule does not stop the second member.
 * A member another seat holds refuses BLOCK_CLAIMED naming it before anything is written, and a seat whose route is below the tier refuses BLOCK_TIER.
 *
 * @param {any} board
 * @param {{ agentId: string, name: string, lane: string, leaseMs: number, freeze: (item: any) => { text: string, digest: string } }} options claim options shared by every member
 * @returns {{ name: string, claimed: number[], leaseUntil: string }}
 */
export function claimBlock(board, { agentId, name, ...options }) {
    const row = board.db.prepare("SELECT meta_value FROM board_meta WHERE meta_key = ?").get(BLOCK_PREFIX + name);
    if (!row) throw new Refused("NO_BLOCK", `no block named ${name}`);
    const block = JSON.parse(row.meta_value);
    const route = routeOf(board, agentId);
    if (!canTake(route, block.tier)) throw new Refused("BLOCK_TIER", `block ${name} needs a ${block.tier} model; you joined on ${route}`);
    const at = now(board);
    for (const id of block.ids) {
      const member = board.db.prepare("SELECT item_owner, item_status, item_lease_until FROM item WHERE item_id = ?").get(id);
      if (member?.item_status === "claimed" && member.item_lease_until > at && member.item_owner !== agentId) {
        throw new Refused("BLOCK_CLAIMED", `item #${id} in block ${name} is held by ${member.item_owner}; a block claim takes every member or none`);
      }
    }
    const original = board.clock;
    const instant = original.now();
    board.clock = { ...original, now: () => new Date(instant.getTime()) };
    try {
      const claimed = [];
      for (const id of block.ids) {
        const member = board.db.prepare("SELECT item_status FROM item WHERE item_id = ?").get(id);
        if (member?.item_status !== "open") continue;
        claim(board, id, { itemFolder: true, perSeat: 10, ...options, agentId });
        claimed.push(id);
      }
      return { name, claimed, leaseUntil: new Date(instant.getTime() + options.leaseMs).toISOString() };
    } finally {
      board.clock = original;
    }
}
