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
import { COORDINATOR } from "../../../../config/index.js";
import { endItemGateJobs } from "../../../../jobs/index.js";

/**
 * Withdraw an item nobody should build: a duplicate, or no longer wanted.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, reason: string, expected?: any, endGateJobs?: boolean, cause?: string, metCommit?: string, commitCarriesWork?: (commit: string) => boolean }} why - cause, metCommit and commitCarriesWork: the system actor's withdraw as met [#12552]. The command passes commitCarriesWork (the commit is on main and is a Merge #N onto main commit for the item, or the item check passes there) because the store reads no repository; without it, or when it is not true, the cited commit is dropped and the table refuses the system actor as it refuses any non-coordinator. endGateJobs: gate.withdrawCancelsJob, passed in by the command because a move never reads a machine setting; the item's open gate and gate-shard jobs end with it [#11819].
 */
export function withdraw(board, id, { agentId, reason, expected = null, endGateJobs = false, cause, metCommit, commitCarriesWork }) {
  atomic(board, () => {
    // The withdraw table decides every refusal, in the order the move declares its guards, and the events the withdrawal writes.
    const met = typeof commitCarriesWork === 'function' && typeof metCommit === 'string' && commitCarriesWork(metCommit) === true;
    const decided = withdrawDecision(board, id, { agentId, reason, expected, cause: met ? cause : undefined, metCommit: met ? metCommit : undefined }, MOVES.find(move => move.verb === 'withdraw').from);
    if (decided.refused?.code === 'NO_ITEM') itemById(board, id);
    if (decided.refused) throw new Refused(decided.refused.code, decided.refused.message);
    moveItem(board, id, 'withdraw', {
      checks: { joined: null, coordinatorOnly: null, noteGiven: null, mainRedUnchanged: null, [IN_STATE]: null },
      set: () => ({ item_withdrawn_reason: reason.trim(), item_owner: null, item_lease_until: null }),
    });
    endWithdrawnHandoff(board, id);
    endReviewLease(board, id);
    if (endGateJobs === true) endItemGateJobs(board.db, { item: id, reason: 'the item was withdrawn' });
    const [withdrawn, ...after] = decided.events;
    // A withdraw the system actor made as met names the cited main commit, so a reader sees what met it [#12552].
    const asMet = met && agentId !== COORDINATOR;
    logEvent(board, withdrawn.by, withdrawn.kind, id, asMet ? { ...withdrawn.detail, commit: metCommit } : withdrawn.detail);
    closeItemAsks(board, id, { agentId, reason: `withdrawn: ${reason.trim()}` });
    for (const event of after) logEvent(board, event.by, event.kind, id, event.detail);
  });
}
