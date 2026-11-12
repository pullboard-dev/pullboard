import { canonicalMilestoneTarget } from '../../../../../index.js';

/** A target is fixed to one instant here, so replicas in other time zones read the same one. */
export function prepareAfter(board, values) {
  if (values[1] && 'target' in values[1]) values[1].target = canonicalMilestoneTarget(values[1].target);
}
