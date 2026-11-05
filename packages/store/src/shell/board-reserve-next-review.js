import { atomic } from "./board-event-log.js";
import { nextFor } from "./board-next-for.js";
import { reserveWithin } from "./board-reserve-review.js";
import { preparedRelaxation } from "./board-reserve-review.js";
import { getItem } from "./board-query.js";
import { reviewHolder } from "./board-query.js";

/** How many times a selection whose item changed before the lock is made again. */
const SELECTION_ATTEMPTS = 3;

/** Whether the chosen item still has the identity it was selected with and no live reviewer. */
function unchanged(board, chosen) {
  const now = getItem(board, chosen.item_id);
  return Boolean(now) && now.item_status === 'submitted' && now.item_commit === chosen.item_commit
    && now.item_frozen_digest === chosen.item_frozen_digest && !reviewHolder(board, now);
}

/**
 * `next --verify` (V15): find the next review the agent may take and reserve it, so no other verifier can take it
 * between the look and the reservation. Why the look runs outside the write transaction: the scan evaluates every
 * candidate for every seat and took 15-25 s inside the lock on a 28-submission board, so every other writer hit
 * BOARD_BUSY (#3156). Inside the lock only the chosen item is checked again; one that changed meanwhile is selected
 * again, and the reserve move's own guards still refuse anything no longer eligible.
 *
 * @param {any} board
 * @param {{ agentId: string, lane: string, leaseMs: number, policy: string, familyPolicy?: string, runnable?: boolean, routes?: string[], skipIds?: number[] }} who - skipIds: items the caller's own session built, never offered (verify refuses them too)
 * @param {{ afterSelection?: (item: any) => void }} [hooks] - Called between the look and the lock; a test may change the board there.
 * @returns {{ item: any | null, reasons: string[] }}
 */
export function reserveNextReview(board, { agentId, lane, leaseMs, policy, familyPolicy = 'off', familyRelaxAt, runnable, routes, skipIds = [], priority = [], observeIdle = false }, { afterSelection } = {}) {
  const who = { agentId, leaseMs, policy, familyPolicy, familyRelaxAt };
  for (let attempt = 1; ; attempt++) {
    const { item, reasons, idleReason } = nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, familyRelaxAt, runnable, routes, skipIds, priority, observeIdle });
    if (!item) return { item: null, reasons, ...(observeIdle ? { idleReason } : {}) };
    const witness = preparedRelaxation(board, item.item_id, who);
    afterSelection?.(item);
    const reserved = atomic(board, () => unchanged(board, item) || attempt >= SELECTION_ATTEMPTS
      ? { item: reserveWithin(board, item.item_id, { ...who, prepared: witness }) } : null);
    if (reserved) return { item: reserved.item, reasons };
  }
}
