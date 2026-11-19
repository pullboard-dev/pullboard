/** The start decision for landing gates: which accepted items start together, pure and fed its setting by the caller [B3,C7]. */
import { parallelGatePlan } from '../../logic/parallel-plan.js';

/**
 * The ids of the accepted items whose gates start now.
 *
 * With `parallel` on, the first group of the parallel plan: items whose changed files and affected tests are disjoint start together.
 * With it off, the first accepted item alone, one batch at a time as today. The caller reads landing.parallelGates and passes it.
 *
 * @param {{ id: number, files?: string[], tests?: string[] }[]} accepted Accepted items in accept order.
 * @param {{ parallel?: boolean }} options
 * @returns {number[]} The ids to start together; empty when nothing is accepted.
 */
export function startGroup(accepted, { parallel = false } = {}) {
  if (accepted.length === 0) return [];
  if (!parallel) return [accepted[0].id];
  return parallelGatePlan(accepted)[0];
}
