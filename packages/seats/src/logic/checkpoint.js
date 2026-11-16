/** The five-part checkpoint fact a seat records so any later session resumes from the board, not from private files [C7,#8548]. */

/** The five parts, in the order a resuming session reads them. */
export const CHECKPOINT_PARTS = Object.freeze(['done', 'left', 'decisions', 'evidence', 'tokens']);

/**
 * Build one checkpoint fact: what is done, what is left, decisions taken, evidence and tokens used.
 *
 * Why every part is always present: a resuming session reads fixed fields, so an unknown part is an empty list or null, never absent.
 *
 * @param {{ done?: string[], left?: string[], decisions?: string[], evidence?: string[], tokens?: number | null }} [parts]
 * @returns {{ done: string[], left: string[], decisions: string[], evidence: string[], tokens: number | null }}
 */
export function buildCheckpoint(parts = {}) {
  const lines = value => (Array.isArray(value) ? value.map(String).filter(Boolean) : []);
  return {
    done: lines(parts.done),
    left: lines(parts.left),
    decisions: lines(parts.decisions),
    evidence: lines(parts.evidence),
    tokens: Number.isFinite(parts.tokens) ? parts.tokens : null,
  };
}
