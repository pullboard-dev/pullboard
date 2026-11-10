import { current } from "../query.js";
import { getItem } from "../query.js";
import { heartbeatSnapshot } from "../query.js";
import { atomic } from "../event/log.js";
import { logEvent } from "../event/log.js";
import { IN_STATE } from "../../../../../state/index.js";
import { Refused } from "../../../../../kernel/index.js";
import { moveItem } from "../../board.js";
import { reviewReleaseCooldown } from "../../board.js";
import { reviewerChecks } from "../../board.js";
import { reviewFamilyRelaxation } from '../review/family.js';
import { confirmFamilyRelaxation } from '../review/family.js';
import { frozenRelaxAt } from '../review/family.js';
import { REVIEW_FAMILY_RELAX_ENGINE } from '../../../../../state/light.js';
import { ENGINE_VERSION } from '../../../../../state/index.js';
import { sweepLapsedReviews } from '../review/lease.js';
import { holdReviewLease } from '../review/lease.js';
import { REVIEW_GATE_RECEIPT_ENGINE } from '../../../../../state/light.js';
import { gateReceiptProblem } from '../../board.js';

/**
 * Reserve an item's review for an agent under a lease (V15): until it runs out, another agent's
 * verdict on the item, or reservation of it, is refused. Reserving again renews the lease.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, leaseMs: number, policy: string, familyPolicy?: string }} who
 * @returns {any} The item, reserved.
 */
export function reserveReview(board, id, who) {
  const known = PREPARED_RESERVES.get(who);
  // A reviewer silent for two minutes loses its reservation: the heartbeats are read here, before the lock opens.
  const reviewHeartbeats = heartbeatSnapshot(board);
  if (known?.board !== board || known.id !== id) return atomic(board, () => reserveWithin(board, id, { ...who, reviewHeartbeats }));
  return atomic(board, () => {
    const found = getItem(board, id);
    // A witness the board no longer supports is never rebuilt in the lock: the writer prepares again outside it.
    if (known.witness && found && !confirmFamilyRelaxation(board, found, known.witness, who.agentId, who.familyRelaxAt, who.policy, who.familyPolicy)) {
      throw new Refused('BOARD_BUSY', 'the review queue changed between the look and the write; run next --verify again');
    }
    return reserveWithin(board, id, { ...who, reviewHeartbeats, prepared: { witness: known.witness } });
  });
}

/** Explicit reservations prepared before the writer's transaction, keyed by the frozen options the writer receives. */
const PREPARED_RESERVES = new WeakMap();

/**
 * The writer's preparation for reserving one named review (registered in board-command-write.js): build its
 * family-relaxation witness before the writer's transaction opens. Why: next --take selects on a read snapshot and
 * then reserves the chosen item by id, and building the queue-wide witness inside the lock held the board for
 * 10-15 s (#3156). The writer receives a frozen copy of the same options, so the recorded move is unchanged.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, leaseMs: number, policy: string, familyPolicy?: string, familyRelaxAt?: number }} who
 * @returns {any} The options, frozen, carrying the prepared witness.
 */
export function prepareReserveReview(board, id, who) {
  const found = getItem(board, id);
  const enabled = (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_FAMILY_RELAX_ENGINE;
  const fits = found && (who.familyRelaxAt === undefined || who.familyRelaxAt === frozenRelaxAt(found));
  const witness = enabled && fits ? reviewFamilyRelaxation(board, found, who.agentId, who.familyRelaxAt, who.policy, who.familyPolicy ?? 'off', null, heartbeatSnapshot(board)) : null;
  const prepared = Object.freeze({ ...who });
  PREPARED_RESERVES.set(prepared, { board, id, witness });
  return prepared;
}

/**
 * The reserve move, inside a transaction the caller holds.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, leaseMs: number, policy: string, familyPolicy?: string, prepared?: { witness: any } }} who -
 *   prepared: a family-relaxation witness next --verify built before the lock. It is confirmed here against the
 *   chosen item and the threshold, never rebuilt, so the lock holds no queue-wide scan; an unconfirmed witness
 *   relaxes nothing and a same-family pair refuses (#3156).
 * @returns {any}
 */
export function reserveWithin(board, id, { agentId, leaseMs, policy, familyPolicy = 'off', familyRelaxAt, prepared, reviewHeartbeats = null }) {
  sweepLapsedReviews(board, reviewHeartbeats);
  const until = new Date(board.clock.now().getTime() + leaseMs).toISOString();
  const found = getItem(board, id);
  // No proof receipt exists while the queued gate runs: a reviewer could only reject it INSUFFICIENT_EVIDENCE (#3737).
  const pending = found && (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_GATE_RECEIPT_ENGINE ? gateReceiptProblem(board, found) : null;
  if (pending) throw pending;
  const frozen = found ? frozenRelaxAt(found) : undefined;
  if (familyRelaxAt !== undefined && familyRelaxAt !== frozen) throw new Refused('BAD_REVIEW_POLICY', 'the stated review backlog threshold differs from the item frozen policy');
  const enabled = (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_FAMILY_RELAX_ENGINE;
  const witness = !enabled || !found ? null
    : prepared ? (prepared.witness ? confirmFamilyRelaxation(board, found, prepared.witness, agentId, familyRelaxAt, policy, familyPolicy) : null)
      : reviewFamilyRelaxation(board, found, agentId, familyRelaxAt, policy, familyPolicy);
  moveItem(board, id, 'reserve', {
    checks: {
      coordinatorSaysAs: null,
      joined: null,
      roadmapReadable: null, // Selection reads recorded queue policy and roadmap before this move; explicit ids consult neither.
      [IN_STATE]: (found) => new Refused('NOT_SUBMITTED', `item #${id} is ${current(board, found).item_status}, not submitted`),
      /** Enforce the cooldown after state validation and before reviewer eligibility [V1]. */
      reviewCooldownElapsed: () => {
        const cooldown = reviewReleaseCooldown(board, id, agentId);
        return cooldown ? new Refused('REVIEW_COOLDOWN', `you released the review of #${id}; try again after ${cooldown}, or let another reviewer take it`) : null;
      },
      ...reviewerChecks(board, { agentId, policy, familyPolicy, reviewHeartbeats, ...(enabled ? { relaxationFor: () => witness } : {}) }),
    },
    set: () => ({ item_review_by: agentId, item_review_until: until }),
  });
  logEvent(board, agentId, 'reserve', id, { until, ...(witness ? { commit: found.item_commit, digest: found.item_frozen_digest, familyRelaxation: witness } : {}) });
  holdReviewLease(board, id, agentId);
  return getItem(board, id);
}
