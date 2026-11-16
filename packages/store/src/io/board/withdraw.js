import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { IN_STATE } from "../../../../state/index.js";
import { Refused } from "../../../../kernel/index.js";
import { moveItem } from "../board.js";
import { endWithdrawnHandoff } from "../submit/handoff/retry.js";
import { endReviewLease } from "./review/lease.js";
import { closeItemAsks } from "./decision/answer.js";
import { MOVES } from "../../../../state/index.js";
import { itemById } from "./query.js";
import { withdrawDecision } from "./withdraw-table.js";

/**
 * Withdraw an item nobody should build: a duplicate, or no longer wanted.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, reason: string }} why
 */
export function withdraw(board, id, { agentId, reason, expected = null }) {
  atomic(board, () => {
    // The withdraw table decides every refusal, in the order the move declares its guards, and the events the withdrawal writes.
    const decided = withdrawDecision(board, id, { agentId, reason, expected }, MOVES.find(move => move.verb === 'withdraw').from);
    if (decided.refused?.code === 'NO_ITEM') itemById(board, id);
    if (decided.refused) throw new Refused(decided.refused.code, decided.refused.message);
    moveItem(board, id, 'withdraw', {
      checks: { joined: null, coordinatorOnly: null, noteGiven: null, mainRedUnchanged: null, [IN_STATE]: null },
      set: () => ({ item_withdrawn_reason: reason.trim(), item_owner: null, item_lease_until: null }),
    });
    endWithdrawnHandoff(board, id);
    endReviewLease(board, id);
    const [withdrawn, ...after] = decided.events;
    logEvent(board, withdrawn.by, withdrawn.kind, id, withdrawn.detail);
    closeItemAsks(board, id, { agentId, reason: `withdrawn: ${reason.trim()}` });
    for (const event of after) logEvent(board, event.by, event.kind, id, event.detail);
  });
}
