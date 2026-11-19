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

const REFUSAL_CODES = Object.freeze(['TOO_LARGE', 'INELIGIBLE', 'BLOCKED']);

/**
 * The stop facts an item thread holds, read from its moves alone: reject and reopen moves count as rejections, and release moves whose
 * detail.reasonCode is TOO_LARGE, INELIGIBLE or BLOCKED count as refusals, counting only moves after the latest edit move that carries a criterion.
 * Why: a reworded criterion is the judgement that resets the count, and stopReason must never read an agent's words.
 *
 * @param {Array<{ type?: string, kind?: string, detail?: object }>} thread The entries itemThread returns.
 * @param {{ openDecision?: boolean, openDependencies?: number[] }} [options] What the caller read from the board: an open decision and the open dependency ids.
 * @returns {{ needsDecision: boolean, blockedBy: number[], rejections: number, refusals: number }}
 */
export function stopFacts(thread, { openDecision = false, openDependencies = [] } = {}) {
  let rejections = 0;
  let refusals = 0;
  for (const entry of thread ?? []) {
    if (entry?.type !== 'move') continue;
    if (entry.kind === 'edit' && entry.detail?.criterion !== undefined && entry.detail?.criterion !== null) { rejections = 0; refusals = 0; }
    else if (entry.kind === 'reject' || entry.kind === 'reopen') rejections += 1;
    else if (entry.kind === 'release' && REFUSAL_CODES.includes(entry.detail?.reasonCode)) refusals += 1;
  }
  return { needsDecision: openDecision === true, blockedBy: Array.isArray(openDependencies) ? [...openDependencies] : [], rejections, refusals };
}
