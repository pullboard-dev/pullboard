import { itemReviewPolicy } from '../../../../../verify/index.js';
import { seatFamily } from '../../../../../verify/index.js';
import { familiesDiffer } from '../../../../../verify/index.js';
import { listItems } from '../query.js';
import { getItem } from '../query.js';
import { reviewHolder } from '../query.js';
import { reviewerChecks } from '../../board.js';
import { reviewReleaseCooldown } from '../../board.js';
import { frozenFamilyPolicy } from '../../relaxation.js';
import { relaxationWitness } from '../../relaxation.js';
import { confirmRelaxation } from '../../relaxation.js';
import { reservedRelaxation } from '../../relaxation.js';
import { frozenRelaxAt } from '../../relaxation.js';

/** Compute a native witness or retain its live reservation; only nextFor supplies a selection-local cache [V1,H16]. */
export function reviewFamilyRelaxation(board, item, agentId, threshold, policy, familyPolicy, cache = null, reviewHeartbeats = null) {
  if (frozenFamilyPolicy(item, familyPolicy) !== 'require' || itemReviewPolicy(board, item.item_id).tier !== 'standard') return null;
  const frozen = frozenRelaxAt(item);
  if (!frozen || threshold !== undefined && threshold !== frozen) return null;
  return reservedRelaxation(board, item, agentId) ?? relaxationWitness(board, item, agentId, frozen, policy,
    { reviewerChecks, reviewHolder, reviewReleaseCooldown, listItems, seatFamily, familiesDiffer, itemReviewPolicy, reviewHeartbeats }, cache);
}

/**
 * Inside the write lock, confirm a witness reviewFamilyRelaxation built before it, without rebuilding it (#3156).
 * Returns the witness, or null when the frozen rule or the board no longer supports it.
 */
export function confirmFamilyRelaxation(board, item, witness, agentId, threshold, policy, familyPolicy, reviewHeartbeats = null) {
  if (frozenFamilyPolicy(item, familyPolicy) !== 'require' || itemReviewPolicy(board, item.item_id).tier !== 'standard') return null;
  const frozen = frozenRelaxAt(item);
  if (!frozen || threshold !== undefined && threshold !== frozen) return null;
  return confirmRelaxation(board, item, witness, agentId, frozen, policy,
    { reviewerChecks, reviewHolder, reviewReleaseCooldown, listItems, getItem, seatFamily, familiesDiffer, itemReviewPolicy, reviewHeartbeats });
}

export { frozenRelaxAt, reservedRelaxation } from '../../relaxation.js';
