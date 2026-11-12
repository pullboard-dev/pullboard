/** The stop reason a returned item gets, derived from board facts alone and never from an agent's words [C7]. */

/** The fixed set of stop reasons, from most to least specific. */
export const STOP_REASONS = Object.freeze(['decision', 'blocked', 'wall', 'rework', 'abandoned']);

/**
 * Derive why work came back: decision (needs a ruling or criterion change), blocked (waiting on another open item),
 * wall (rejected or refused twice or more on the same item), rework (rejected once) or abandoned (idle or session ended, no refusal).
 * Why: a free-text note is the agent's own story; routing needs a reason the agent cannot choose.
 * Only the counts and ids below are read; any `note` or other field on the facts is ignored.
 *
 * @param {{ needsDecision?: boolean, blockedBy?: number[], rejections?: number, refusals?: number }} [facts]
 * @returns {'decision' | 'blocked' | 'wall' | 'rework' | 'abandoned'}
 */
export function stopReason(facts = {}) {
  const { needsDecision, blockedBy, rejections, refusals } = facts;
  if (needsDecision === true) return 'decision';
  if (Array.isArray(blockedBy) && blockedBy.length > 0) return 'blocked';
  const returns = (Number.isInteger(rejections) ? rejections : 0) + (Number.isInteger(refusals) ? refusals : 0);
  if (returns >= 2) return 'wall';
  if (returns === 1) return 'rework';
  return 'abandoned';
}
