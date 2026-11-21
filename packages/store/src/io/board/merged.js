import { requireOutsideOwner } from "../../../../items/index.js";
import { itemById } from "./query.js";
import { proofReceipts } from "./query.js";
import { atomic } from "./event/log.js";
import { logEvent } from "./event/log.js";
import { Refused } from "../../../../kernel/index.js";
import { coordinatorOnly } from "../board.js";
import { setItem } from "../board.js";
import { endReservation } from "./hold/item.js";
import { closeItemAsks } from "./decision/answer.js";
import { withdraw } from "./withdraw.js";
import { endItemGateJobs } from "../../../../jobs/index.js";
import { FORCED_MERGE_ENGINE } from "../../../../state/index.js";
import { measureBoardWritePhase } from "./write/lock.js";
import { mergedDecision } from "./merged-table.js";
import { strictFacts } from "./merged-table.js";

/**
 * Record the commit a verified item landed as on the main line, e.g. after a squash merge.
 *
 * @param {any} board
 * @param {number} id
 * A forced merge (`forced` is the reason) records work landed around the gate at a commit, even when the item was open or
 * withdrawn as met; its event is marked forced, and a withdrawn item with a merged event reads as landed on the board and /live.
 * Why: hand landings were withdrawn as met, which /live and stats do not count [C7].
 *
 * A forced merge also names its proof: the passing receipt ids covering the item's tip, which the event carries with the tip. A tip with
 * no covering receipt is refused unless `waiveProof` gives a reason [#4742].
 *
 * With `composeLanding`, the parent's landed commit already holds its composed slices, so each submitted slice child of the parent is
 * withdrawn in the same atomic write as the merged record, with the reason "landed with parent #<parent> at <sha12>" [C7,#2397].
 *
 * @param {{ agentId: string, commit: string, note?: string, forced?: string, waiveProof?: string, composeLanding?: boolean, endGateJobs?: boolean }} merge
 */
export function merged(board, id, { agentId, commit, note = '', flakeRatchet, forced, waiveProof, composeLanding, endGateJobs = false }) {
  coordinatorOnly(agentId, 'records merges');
  const reason = typeof forced === 'string' ? forced.trim() : '';
  if (forced !== undefined && !reason) throw new Refused('FORCED_REASON', 'a forced merge names why it went around the gate: --forced "<why>"');
  if (reason && (board.executionEngineVersion !== undefined && board.executionEngineVersion < FORCED_MERGE_ENGINE)) {
    throw new Refused('ENGINE_VERSION', `a forced merge requires engine ${FORCED_MERGE_ENGINE}; upgrade Pullboard before recording one`);
  }
  const waiver = typeof waiveProof === 'string' ? waiveProof.trim() : '';
  if (waiveProof !== undefined && !waiver) throw new Refused('WAIVE_PROOF_REASON', 'a proof waiver names why: --waive-proof "<why>"');
  // Each named part is timed, so the hold row of a long merge names its slowest step [C7,#12605].
  const phase = (name, work) => measureBoardWritePhase(board.db, name, work);
  atomic(board, () => {
    const item = itemById(board, id);
    // A second merge writes nothing for the same commit and refuses for another, so a landing is recorded once.
    if (item.item_merged_commit) {
      if (item.item_merged_commit === commit) return;
      throw new Refused('ALREADY_MERGED', `item #${id} was merged as ${item.item_merged_commit}; it cannot be merged again as ${commit}`);
    }
    const tip = item.item_commit ?? null;
    // Only a passing run (exit code 0) for this exact tip is proof; a forced merge with none needs --waive-proof [#4742].
    const receipts = reason && tip ? phase('merged-proof-receipts', () => proofReceipts(board, id).filter(run => run.commit === tip && run.exitCode === 0).map(run => run.id)) : [];
    if (reason && !receipts.length && !waiver) {
      throw new Refused('FORCED_NO_PROOF', `no passing receipt covers item #${id}'s tip ${tip ? tip.slice(0, 12) : '(none recorded)'}; run its check there, or record the landing with --waive-proof "<why>"`);
    }
    // The landing merged table decides what a merge refuses and records; where it is not available the writer's own rules below stand [C7,#8268].
    const decided = phase('merged-decision', () => mergedDecision({ id, status: item.item_status, mergedCommit: item.item_merged_commit }, { agentId, commit, forced: reason || undefined }, strictFacts(board, item)));
    if (decided?.refused) throw new Refused(decided.refused.code, decided.refused.message, decided.refused.next);
    if (!decided && !reason && item.item_status !== 'verified') {
      throw new Refused('NOT_VERIFIED', `item #${id} is ${item.item_status}; merge verified work only`);
    }
    const withdrawal = decided?.events?.find(event => event.kind === 'withdraw');
    const decidedMerge = decided?.events?.find(event => event.kind === 'merged')?.detail;
    if (!reason) requireOutsideOwner(board, item);
    // A forced landing closes an unfinished item by the ordinary withdraw move; the merged event then reads it as landed.
    if (reason && ['open', 'claimed', 'submitted'].includes(item.item_status)) {
      phase('merged-withdraw', () => withdraw(board, id, { agentId, reason: withdrawal?.detail.reason ?? `landed by hand at ${commit.slice(0, 12)}: ${reason}`, endGateJobs }));
    }
    phase('merged-record', () => setItem(board, id, { item_merged_commit: commit }));
    logEvent(board, agentId, 'merged', id, { commit, ...(note.trim() ? { note: note.trim() } : {}),
      ...(reason ? { forced: true, reason, from: item.item_status, itemTip: tip, receipts, ...(waiver ? { waivedProof: waiver } : {}) } : {}),
      ...(flakeRatchet === undefined ? {} : { flakeRatchet }), ...(decidedMerge ?? {}) });
    // A strict item with a counting full-suite receipt lands and publishes in the one transaction: the table's published event follows the merged one [M2,#9327].
    phase('merged-published', () => { for (const event of decided?.events?.filter(each => each.kind === 'published') ?? []) logEvent(board, agentId, 'published', id, event.detail); });
    phase('merged-close-asks', () => closeItemAsks(board, id, { agentId, reason: 'landed' }));
    // route.reservations: a reservation ends when its item lands [C7,#9162].
    phase('merged-end-reservation', () => endReservation(board, id, { agentId, why: 'item landed' }));
    if (composeLanding === true) {
      const slices = board.db.prepare("SELECT item_id FROM item WHERE item_parent_id = ? AND item_status = 'submitted' AND EXISTS (SELECT 1 FROM board_meta WHERE meta_key = 'item-slice:' || item_id) ORDER BY item_id").all(id);
      phase('merged-compose-slices', () => { for (const slice of slices) withdraw(board, slice.item_id, { agentId, reason: `landed with parent #${id} at ${commit.slice(0, 12)}` }); });
    }
    if (endGateJobs === true) phase('merged-end-gate-jobs', () => endItemGateJobs(board.db, { item: id, reason: 'the item landed' }));
  });
}
