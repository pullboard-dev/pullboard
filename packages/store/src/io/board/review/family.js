import { itemReviewPolicy } from '../../../../../verify/index.js';
import { seatFamily } from '../../../../../verify/index.js';
import { familiesDiffer } from '../../../../../verify/index.js';
import { listItems } from '../query.js';
import { getItem } from '../query.js';
import { reviewHolder } from '../query.js';
import { requiredReviewFamily } from '../../../../../verify/index.js';
import { requiredReviewFamilyProblem } from '../../../../../verify/index.js';
import { classifiedStrict } from '../../../../../verify/index.js';
import { reviewerChecks } from '../../board.js';
import { relaxRequiredFamilyEnabled } from '../../board.js';
import { reviewReleaseCooldown } from '../../board.js';
import { frozenFamilyPolicy } from '../../relaxation.js';
import { relaxationWitness } from '../../relaxation.js';
import { confirmRelaxation } from '../../relaxation.js';
import { reservedRelaxation } from '../../relaxation.js';
import { frozenRelaxAt } from '../../relaxation.js';
import { relaxableTier } from '../../relaxation.js';

/** Whether the item waits on a required reviewer family and review.relaxRequiredFamily lets that wait widen [C7,#11127]. */
function requiredFamilyWaits(board, item) {
  return Boolean(item.item_review_family ?? requiredReviewFamily(board, item.item_id)) && relaxRequiredFamilyEnabled();
}

/** Compute a native witness or retain its live reservation; only nextFor supplies a selection-local cache [V1,H16]. */
export function reviewFamilyRelaxation(board, item, agentId, threshold, policy, familyPolicy, cache = null, reviewHeartbeats = null) {
  if (frozenFamilyPolicy(item, familyPolicy) !== 'require' && !requiredFamilyWaits(board, item) || !relaxableTier(board, item, itemReviewPolicy, classifiedStrict, requiredFamilyWaits(board, item))) return null;
  const frozen = frozenRelaxAt(item);
  if (!frozen || threshold !== undefined && threshold !== frozen) return null;
  return reservedRelaxation(board, item, agentId) ?? relaxationWitness(board, item, agentId, frozen, policy,
    { reviewerChecks, reviewHolder, reviewReleaseCooldown, listItems, seatFamily, familiesDiffer, itemReviewPolicy, classifiedStrict, reviewHeartbeats, requiredFamilyWaits: found => requiredFamilyWaits(board, found) }, cache);
}

/**
 * Inside the write lock, confirm a witness reviewFamilyRelaxation built before it, without rebuilding it (#3156).
 * Returns the witness, or null when the frozen rule or the board no longer supports it.
 */
export function confirmFamilyRelaxation(board, item, witness, agentId, threshold, policy, familyPolicy, reviewHeartbeats = null) {
  if (frozenFamilyPolicy(item, familyPolicy) !== 'require' && !requiredFamilyWaits(board, item) || !relaxableTier(board, item, itemReviewPolicy, classifiedStrict, requiredFamilyWaits(board, item))) return null;
  const frozen = frozenRelaxAt(item);
  if (!frozen || threshold !== undefined && threshold !== frozen) return null;
  return confirmRelaxation(board, item, witness, agentId, frozen, policy,
    { reviewerChecks, reviewHolder, reviewReleaseCooldown, listItems, getItem, seatFamily, familiesDiffer, itemReviewPolicy, classifiedStrict, reviewHeartbeats, requiredFamilyWaits: found => requiredFamilyWaits(board, found) });
}

/**
 * The text a verdict record carries when its review ran under a relaxation witness and the seat is of another family than the item's
 * required reviewer family, so the record names that the required family was widened and why; null when nothing was widened [C7,#9838].
 * It reads only the item's stored required family and the seat's family, never the setting, so a replayed verdict records the same text.
 */
export function widenedFamilyRecord(board, item, agentId) {
  const required = requiredReviewFamily(board, item.item_id);
  if (!required || !requiredReviewFamilyProblem(board, item, agentId)) return null;
  return `required reviewer family ${required} widened: no live eligible seat of the family for 20 minutes`;
}

/** The verdict-note line for a review that ran under a relaxation witness, naming a widened required family and why when the family was widened [C7,#9838]. */
export function relaxationRecordLine(board, item, agentId, relaxation) {
  const widened = widenedFamilyRecord(board, item, agentId);
  return `review family relaxed at reservation: ${relaxation.queueLength} waiting, threshold ${relaxation.threshold}; active seats: ${relaxation.activeSeats.join(', ') || 'none'}${widened ? `; ${widened}` : ''}`;
}

export { frozenRelaxAt, reservedRelaxation } from '../../relaxation.js';
