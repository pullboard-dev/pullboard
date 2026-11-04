import { idleReason } from "../../../seats/index.js";
import { atomic } from "./board-event-log.js";
import { nextFor } from "./board-next-for.js";
import { reserveWithin } from "./board-reserve-review.js";
import { listAgents } from './board-query.js';

/**
 * `next --verify` (V15): find the next review the agent may take and reserve it in one
 * transaction, so no other verifier can take it between the look and the reservation.
 *
 * @param {any} board
 * @param {{ agentId: string, lane: string, leaseMs: number, policy: string, familyPolicy?: string, runnable?: boolean, routes?: string[], skipIds?: number[] }} who - skipIds: items the caller's own session built, never offered (verify refuses them too)
 * @returns {{ item: any | null, reasons: string[] }}
 */
export function reserveNextReview(board, { agentId, lane, leaseMs, policy, familyPolicy = 'off', familyRelaxAt, runnable, routes, skipIds = [], priority = [], observeIdle = false }) {
  const reviewHeartbeats = new Map(listAgents(board).map(({ agent_id, heartbeatAt }) => [agent_id, heartbeatAt]));
  return atomic(board, () => {
    const { item, reasons, idleReason } = nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, familyRelaxAt, runnable, routes, skipIds, priority, observeIdle, reviewHeartbeats });
    return item ? { item: reserveWithin(board, item.item_id, { agentId, leaseMs, policy, familyPolicy, familyRelaxAt, reviewHeartbeats }), reasons } : { item: null, reasons, ...(observeIdle ? { idleReason } : {}) };
  });
}
