import { idleReason } from './routing-presence.js';
import { atomic } from './board-event-log.js';
import { nextFor } from './board-next-for.js';
import { reserveWithin } from './board-reserve-review.js';

/**
 * `next --verify` (V15): find the next review the agent may take and reserve it in one
 * transaction, so no other verifier can take it between the look and the reservation.
 *
 * @param {any} board
 * @param {{ agentId: string, lane: string, leaseMs: number, policy: string, familyPolicy?: string, runnable?: boolean, routes?: string[], skipIds?: number[] }} who - skipIds: items the caller's own session built, never offered (verify refuses them too)
 * @returns {{ item: any | null, reasons: string[] }}
 */
export function reserveNextReview(board, { agentId, lane, leaseMs, policy, familyPolicy = 'off', runnable, routes, skipIds = [], priority = [], observeIdle = false }) {
  return atomic(board, () => {
    const { item, reasons, idleReason } = nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, runnable, routes, skipIds, priority, observeIdle });
    return item ? { item: reserveWithin(board, item.item_id, { agentId, leaseMs, policy, familyPolicy }), reasons } : { item: null, reasons, ...(observeIdle ? { idleReason } : {}) };
  });
}
