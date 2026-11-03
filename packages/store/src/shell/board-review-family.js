import { itemReviewPolicy } from '../../../verify/index.js';
import { seatFamily } from '../../../verify/index.js';
import { familiesDiffer } from '../../../verify/index.js';
import { listItems } from './board-query.js';
import { reviewHolder } from './board-query.js';
import { reviewerChecks } from './board.js';
import { reviewReleaseCooldown } from './board.js';
import { frozenFamilyPolicy } from './review-family-relaxation.js';
import { relaxationWitness } from './review-family-relaxation.js';
import { reservedRelaxation } from './review-family-relaxation.js';
import { frozenRelaxAt } from './review-family-relaxation.js';

/** Compute a native witness or retain its live reservation; only nextFor supplies a selection-local cache [V1,H16]. */
export function reviewFamilyRelaxation(board, item, agentId, threshold, policy, familyPolicy, cache = null) {
  if (frozenFamilyPolicy(item, familyPolicy) !== 'require' || itemReviewPolicy(board, item.item_id).tier !== 'standard') return null;
  const frozen = frozenRelaxAt(item);
  if (!frozen || threshold !== undefined && threshold !== frozen) return null;
  return reservedRelaxation(board, item, agentId) ?? relaxationWitness(board, item, agentId, frozen, policy,
    { reviewerChecks, reviewHolder, reviewReleaseCooldown, listItems, seatFamily, familiesDiffer, itemReviewPolicy }, cache);
}

export { frozenRelaxAt, reservedRelaxation } from './review-family-relaxation.js';
