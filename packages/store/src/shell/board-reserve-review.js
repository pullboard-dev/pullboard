import { current } from "./board-query.js";
import { getItem } from "./board-query.js";
import { atomic } from "./board-event-log.js";
import { logEvent } from "./board-event-log.js";
import { IN_STATE } from "../../../state/index.js";
import { Refused } from "../../../kernel/index.js";
import { moveItem } from "./board.js";
import { reviewReleaseCooldown } from "./board.js";
import { reviewerChecks } from "./board.js";
import { seatFamily } from "./board.js";
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
 * Build the family-relaxation witness for an item outside any write transaction, bound to the head and bar it was
 * built for. Why: each witness walks every waiting review for every seat (0.5-0.9 s on a 28-submission board), and
 * inside the lock that blocked every other writer (#3156).
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, policy: string, familyPolicy?: string, familyRelaxAt?: number }} who
 * @returns {{ commit: string, digest: string, witness: any } | null}
 */
export function preparedRelaxation(board, id, { agentId, policy, familyPolicy = 'off', familyRelaxAt }) {
  const found = getItem(board, id);
  if (!found || (board.executionEngineVersion ?? ENGINE_VERSION) < REVIEW_FAMILY_RELAX_ENGINE) return null;
  if (familyRelaxAt !== undefined && familyRelaxAt !== frozenRelaxAt(found)) return null;
  return { commit: found.item_commit, digest: found.item_frozen_digest, inputs: relaxationInputs(board),
    witness: reviewFamilyRelaxation(board, found, agentId, familyRelaxAt, policy, familyPolicy) };
}

/**
 * The cheap facts a relaxation witness is derived from: every waiting submission with its head, bar and live
 * reviewer, the seats active in the witness window with their families, lanes and routes, the latest review release and every release
 * cooldown still running. Why: a
 * witness prepared before the lock is reused only while these are unchanged, so another reviewer reserving a waiting
 * item, a seat arriving or a release between the look and the lock rebuilds it instead (#3156).
 *
 * @param {any} board
 * @returns {string}
 */
export function relaxationInputs(board) {
  const now = board.clock.now();
  const at = now.toISOString(), cutoff = new Date(now.getTime() - 15 * 60_000).toISOString();
  const waiting = board.db.prepare("SELECT item_id,item_commit,item_frozen_digest,item_review_by,item_review_until FROM item WHERE item_status='submitted' ORDER BY item_id").all()
    .map(row => [row.item_id, row.item_commit, row.item_frozen_digest, row.item_review_by && (row.item_review_until ?? '') > at ? row.item_review_by : null]);
  const route = board.db.prepare('SELECT agent_lane AS lane, agent_route AS route FROM agent WHERE agent_id=?');
  const active = board.db.prepare('SELECT DISTINCT event_by AS id FROM event WHERE event_at>=? AND event_at<=? ORDER BY event_by').all(cutoff, at)
    .map(row => { const seat = route.get(row.id); return [row.id, seatFamily(board, row.id), seat?.lane ?? null, seat?.route ?? null]; });
  const released = board.db.prepare("SELECT MAX(event_id) AS id FROM event WHERE event_kind IN ('release','review-release')").get()?.id ?? null;
  // A release cooldown ends with time alone, so each live one is part of the inputs, evaluated now (#3156).
  const cooling = board.db.prepare("SELECT DISTINCT event.item_id AS item, event.event_by AS seat FROM event JOIN item ON item.item_id=event.item_id WHERE item.item_status='submitted' AND event.event_kind='release' ORDER BY event.item_id, event.event_by").all()
    .filter(row => reviewReleaseCooldown(board, row.item, row.seat)).map(row => [row.item, row.seat]);
  return JSON.stringify({ waiting, active, released, cooling });
}

/**
 * The reserve move, inside a transaction the caller holds.
 *
 * @param {any} board
 * @param {number} id
 * @param {{ agentId: string, leaseMs: number, policy: string, familyPolicy?: string }} who
 * @returns {any}
 */
export function reserveWithin(board, id, { agentId, leaseMs, policy, familyPolicy = 'off', familyRelaxAt, prepared }) {
  const until = new Date(board.clock.now().getTime() + leaseMs).toISOString();
  const found = getItem(board, id);
  const frozen = found ? frozenRelaxAt(found) : undefined;
  if (familyRelaxAt !== undefined && familyRelaxAt !== frozen) throw new Refused('BAD_REVIEW_POLICY', 'the stated review backlog threshold differs from the item frozen policy');
  const enabled = (board.executionEngineVersion ?? ENGINE_VERSION) >= REVIEW_FAMILY_RELAX_ENGINE;
  // A witness prepared before the lock for this exact head and bar is reused; anything else is built here.
  const reuse = prepared && found && prepared.commit === found.item_commit && prepared.digest === found.item_frozen_digest
    && prepared.inputs === relaxationInputs(board);
  // A prepared witness that no longer matches is never rebuilt here, inside the caller's lock: the look runs again.
  if (prepared && !reuse) throw new Refused('REVIEW_QUEUE_CHANGED', 'the review queue changed since this review was chosen; run next --verify again');
  const witness = reuse ? prepared.witness : enabled && found ? reviewFamilyRelaxation(board, found, agentId, familyRelaxAt, policy, familyPolicy) : null;
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
