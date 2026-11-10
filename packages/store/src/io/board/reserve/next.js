import { atomic } from "../event/log.js";
import { nextFor } from "../next.js";
import { reserveWithin } from "./review.js";
import { getItem } from "../query.js";
import { heartbeatSnapshot } from "../query.js";
import { reviewFamilyRelaxation } from "../review/family.js";
import { frozenRelaxAt } from "../review/family.js";
import { REVIEW_FAMILY_RELAX_ENGINE } from "../../../../../state/light.js";
import { ENGINE_VERSION } from "../../../../../state/index.js";
import { Refused } from "../../../../../kernel/index.js";

/** How many times a selection whose item changed before the lock is made again, when no preparation ran. */
const SELECTION_ATTEMPTS = 3;

/** Refusals that mean the chosen item or its witness changed since the look, so the look runs again. */
const CHOICE_CHANGED = new Set(['REVIEW_HELD', 'NOT_SUBMITTED', 'NO_ITEM', 'ITEM_MOVED', 'REVIEW_COOLDOWN', 'SAME_FAMILY', 'O2_FAMILY_MATCH']);

/** Selections made before the writer's transaction, keyed by the frozen selection the writer receives. */
const PREPARED = new WeakMap();

/**
 * Make the look for `next --verify`: the scan over every candidate for every seat, and for a same-family pair the
 * family-relaxation witness. Why it is separate: both are expensive (15-25 s and 0.5-0.9 s on a 28-submission board)
 * and must run before any write transaction (#3156).
 *
 * @param {any} board
 * @param {any} selection
 * @param {{ afterSelection?: (item: any) => void }} [hooks]
 * @returns {{ item: any | null, reasons: string[], idleReason?: any, witness?: any }}
 */
function look(board, { agentId, lane, policy, familyPolicy = 'off', familyRelaxAt, runnable, routes, skipIds = [], priority = [], observeIdle = false }, { afterSelection } = {}) {
  const reviewHeartbeats = heartbeatSnapshot(board);
  const found = nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, familyRelaxAt, runnable, routes, skipIds, priority, observeIdle, reviewHeartbeats });
  if (!found.item) return found;
  const enabled = (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_FAMILY_RELAX_ENGINE;
  const fits = familyRelaxAt === undefined || familyRelaxAt === frozenRelaxAt(found.item);
  // Cross-family pairs return null at once; only a same-family pair pays for the queue-wide witness, here.
  const witness = enabled && fits ? reviewFamilyRelaxation(board, found.item, agentId, familyRelaxAt, policy, familyPolicy, null, reviewHeartbeats) : null;
  afterSelection?.(found.item);
  return { ...found, witness };
}

/**
 * The writer's preparation for `next --verify` (registered in board-command-write.js): run the look before the
 * writer's transaction opens, so the lock holds only the per-pair recheck (#3156). The writer receives a frozen copy
 * of the same selection, so the recorded move's arguments are unchanged.
 *
 * @param {any} board
 * @param {any} selection
 * @param {{ afterSelection?: (item: any) => void }} [hooks]
 * @returns {any} The selection, frozen, carrying its prepared look.
 */
export function prepareReserveNextReview(board, selection, hooks) {
  const prepared = Object.freeze({ ...selection });
  PREPARED.set(prepared, { board, found: look(board, selection, hooks) });
  return prepared;
}

/**
 * Reserve the chosen review inside one write transaction, or null when it changed since the look. Inside the lock only
 * the per-pair guards run for this one seat and item (reviewerChecks and reviewFree), and a same-family pair's witness
 * is confirmed against the chosen item and the threshold, never rebuilt (#3156).
 */
function reserveChosen(board, chosen, witness, who) {
  const reviewHeartbeats = heartbeatSnapshot(board);
  return atomic(board, () => {
    const now = getItem(board, chosen.item_id);
    if (!now || now.item_status !== 'submitted' || now.item_commit !== chosen.item_commit || now.item_frozen_digest !== chosen.item_frozen_digest) return null;
    try {
      return reserveWithin(board, chosen.item_id, { ...who, reviewHeartbeats, prepared: { witness } });
    } catch (error) {
      if (error instanceof Refused && CHOICE_CHANGED.has(error.code)) return null;
      throw error;
    }
  });
}

/**
 * `next --verify` (V15): find the next review the agent may take and reserve it, so no other verifier can take it
 * between the look and the reservation. Why the look runs outside the write transaction: the scan evaluates every
 * candidate for every seat and took 15-25 s inside the lock on a 28-submission board, so every other writer hit
 * BOARD_BUSY (#3156). The guarantee holds because the reservation's own guards run again inside the lock: a review
 * another verifier took meanwhile refuses REVIEW_HELD and reserves nothing, and a witness the board no longer
 * supports relaxes nothing. Under the writer, a stale prepared look
 * refuses BOARD_BUSY so the writer prepares again outside its lock; a direct call looks again itself.
 *
 * @param {any} board
 * @param {{ agentId: string, lane: string, leaseMs: number, policy: string, familyPolicy?: string, runnable?: boolean, routes?: string[], skipIds?: number[] }} selection - skipIds: items the caller's own session built, never offered (verify refuses them too)
 * @param {{ afterSelection?: (item: any) => void }} [hooks] - Called between the look and the lock; a test may change the board there.
 * @returns {{ item: any | null, reasons: string[] }}
 */
export function reserveNextReview(board, selection, hooks = {}) {
  const { agentId, leaseMs, policy, familyPolicy = 'off', familyRelaxAt, observeIdle = false } = selection;
  const who = { agentId, leaseMs, policy, familyPolicy, familyRelaxAt };
  const known = PREPARED.get(selection);
  for (let attempt = 1; ; attempt++) {
    const { item, reasons, idleReason, witness } = attempt === 1 && known?.board === board ? known.found : look(board, selection, hooks);
    if (!item) return { item: null, reasons, ...(observeIdle ? { idleReason } : {}) };
    const reserved = reserveChosen(board, item, witness ?? null, who);
    if (reserved) return { item: reserved, reasons };
    if (known) throw new Refused('BOARD_BUSY', 'the review queue changed between the look and the write; run next --verify again');
    if (attempt >= SELECTION_ATTEMPTS) return { item: null, reasons: [...reasons, 'the review queue changed during every look; run next again'] };
  }
}
