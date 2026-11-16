/** The withdraw move table run over the live board: the store's withdraw writer reads its refusals and its events from it [C7,#8273]. */
import { runWithdrawTable } from "../../logic/board/landing/lease.js";

/**
 * Run the withdraw table for an item and a caller, over the board as it stands before any write.
 * Why: one table decides the refusal, the withdraw event and the audit's cause fact, so the writer carries no second copy of those rules.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, reason: string, expected: object | null }} call
 * @param {readonly string[]} from - The states the lifecycle machine lets a withdrawal start from.
 * @returns {{ refused?: { code: string, message: string }, events?: object[] }}
 */
export function withdrawDecision(board, id, call, from) {
  const found = board.db.prepare('SELECT item_status, item_title, item_check, item_frozen, item_frozen_digest FROM item WHERE item_id=?').get(id);
  const snapshot = { actor: { id: call.agentId, joined: true },
    item: found ? { id, status: found.item_status, title: found.item_title, check: found.item_check, frozen: found.item_frozen, frozenDigest: found.item_frozen_digest } : null };
  const move = { id, actor: call.agentId, reason: call.reason, expected: call.expected };
  return runWithdrawTable(from, structuredClone(snapshot), structuredClone(move));
}
