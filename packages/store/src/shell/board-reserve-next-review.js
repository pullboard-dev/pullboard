import { atomic } from "./board-event-log.js";
import { nextFor } from "./board-next-for.js";
import { reserveWithin } from "./board-reserve-review.js";
import { getItem } from "./board-query.js";
import { Refused } from "../../../kernel/index.js";

/** How many times a selection whose item changed before the lock is made again, when no preparation ran. */
const SELECTION_ATTEMPTS = 3;

/** Refusals of the cheap pair check that only a same-family relaxation could lift: the rare in-lock path. */
const NEEDS_RELAXATION = new Set(['SAME_FAMILY', 'O2_FAMILY_MATCH']);

/** Refusals that mean the chosen item changed since the look, so the look runs again. */
const CHOICE_CHANGED = new Set(['REVIEW_HELD', 'NOT_SUBMITTED', 'NO_ITEM', 'ITEM_MOVED', 'REVIEW_COOLDOWN', ...NEEDS_RELAXATION]);

/** Selections made before the writer's transaction, keyed by the frozen selection the writer receives. */
const PREPARED = new WeakMap();

/**
 * Make the look for `next --verify`: the scan over every candidate for every seat. Why it is separate: it is the
 * expensive part (15-25 s on a 28-submission board) and must run before any write transaction (#3156).
 *
 * @param {any} board
 * @param {any} selection
 * @param {{ afterSelection?: (item: any) => void }} [hooks]
 * @returns {{ item: any | null, reasons: string[], idleReason?: any }}
 */
function look(board, { agentId, lane, policy, familyPolicy = 'off', familyRelaxAt, runnable, routes, skipIds = [], priority = [], observeIdle = false }, { afterSelection } = {}) {
  const found = nextFor(board, { agentId, lane, verify: true, policy, familyPolicy, familyRelaxAt, runnable, routes, skipIds, priority, observeIdle });
  if (found.item) afterSelection?.(found.item);
  return found;
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
 * the per-pair guards run for this one seat and item (reviewerChecks and reviewFree), with no relaxation witness. A
 * pair that needs a same-family relaxation is rare, so it is reserved the old way, its witness built in this lock.
 */
function reserveChosen(board, chosen, who) {
  return atomic(board, () => {
    const now = getItem(board, chosen.item_id);
    if (!now || now.item_status !== 'submitted' || now.item_commit !== chosen.item_commit || now.item_frozen_digest !== chosen.item_frozen_digest) return null;
    try {
      return reserveWithin(board, chosen.item_id, { ...who, relax: false });
    } catch (error) {
      if (!(error instanceof Refused) || !CHOICE_CHANGED.has(error.code)) throw error;
      if (!NEEDS_RELAXATION.has(error.code)) return null;
    }
    try {
      return reserveWithin(board, chosen.item_id, who);
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
 * another verifier took meanwhile refuses REVIEW_HELD and reserves nothing. Under the writer, a stale prepared look
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
    const { item, reasons, idleReason } = attempt === 1 && known?.board === board ? known.found : look(board, selection, hooks);
    if (!item) return { item: null, reasons, ...(observeIdle ? { idleReason } : {}) };
    const reserved = reserveChosen(board, item, who);
    if (reserved) return { item: reserved, reasons };
    if (known) throw new Refused('BOARD_BUSY', 'the review queue changed between the look and the write; run next --verify again');
    if (attempt >= SELECTION_ATTEMPTS) return { item: null, reasons: [...reasons, 'the review queue changed during every look; run next again'] };
  }
}
