/** The landing merged table run over the live board: the store's merged writer reads its refusal and the events of a merge from it [C7,#8268]. */
import { runMergedTable } from '../../logic/board/landing/lease.js';

/**
 * Decide a merge with the landing merged table, over the item as it stands before the move writes anything.
 * Why: one table decides the coordinator and forced-reason guards, the verified-only guard, the merged event and a forced merge's withdrawal, so the writer carries no second copy of those rules.
 * Returns null when the table is not available or throws (a store used without its composition root, or a damaged row): the writer then keeps its own rules, so behaviour never changes.
 *
 * @param {{ id: number, status: string, mergedCommit?: string | null }} item - The item row before the move.
 * @param {{ agentId: string, commit: string, forced?: string }} call
 * @returns {{ refused?: { code: string, message: string, next?: string }, events?: object[] } | null}
 */
export function mergedDecision(item, call) {
  const move = { id: item.id, actor: call.agentId, commit: call.commit, ...(call.forced === undefined ? {} : { forced: call.forced }) };
  try { return runMergedTable(structuredClone({ item: { id: item.id, status: item.status, mergedCommit: item.mergedCommit ?? null } }), move); } catch { return null; }
}
