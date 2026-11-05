import { current } from "./board-query.js";
import { getItem } from "./board-query.js";
import { atomic } from "./board-event-log.js";
import { logEvent } from "./board-event-log.js";
import { IN_STATE } from "../../../state/index.js";
import { Refused } from "../../../kernel/index.js";
import { moveItem } from "./board.js";
import { reviewReleaseCooldown } from "./board.js";
import { reviewerChecks } from "./board.js";
import { reviewFamilyRelaxation } from './board-review-family.js';
import { frozenRelaxAt } from './board-review-family.js';
import { REVIEW_FAMILY_RELAX_ENGINE } from '../../../../src/review-family-relax-engine.js';
import { ENGINE_VERSION } from '../../../state/index.js';

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
  return atomic(board, () => reserveWithin(board, id, who));
}

/**
 * The reserve move, inside a transaction the caller holds.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, leaseMs: number, policy: string, familyPolicy?: string, relax?: boolean }} who - relax: false
 *   checks the pair under the item's frozen family rule with no relaxation witness, the cheap per-pair check that
 *   next --verify runs in the lock; a same-family pair then refuses, and the caller reserves it the old way (#3156).
 * @returns {any}
 */
export function reserveWithin(board, id, { agentId, leaseMs, policy, familyPolicy = 'off', familyRelaxAt, relax = true }) {
  const until = new Date(board.clock.now().getTime() + leaseMs).toISOString();
  const found = getItem(board, id);
  const frozen = found ? frozenRelaxAt(found) : undefined;
  if (familyRelaxAt !== undefined && familyRelaxAt !== frozen) throw new Refused('BAD_REVIEW_POLICY', 'the stated review backlog threshold differs from the item frozen policy');
  const enabled = (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_FAMILY_RELAX_ENGINE;
  const witness = relax && enabled && found ? reviewFamilyRelaxation(board, found, agentId, familyRelaxAt, policy, familyPolicy) : null;
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
      ...reviewerChecks(board, { agentId, policy, familyPolicy, ...(enabled ? { relaxationFor: () => witness } : {}) }),
    },
    set: () => ({ item_review_by: agentId, item_review_until: until }),
  });
  logEvent(board, agentId, 'reserve', id, { until, ...(witness ? { commit: found.item_commit, digest: found.item_frozen_digest, familyRelaxation: witness } : {}) });
  return getItem(board, id);
}
