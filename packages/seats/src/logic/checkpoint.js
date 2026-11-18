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

/** The four seat-loop moments that record a checkpoint, as the fact text names them. */
export const CHECKPOINT_MOMENTS = Object.freeze(['claim', 'submit', 'exit-stop', 'handoff']);

/**
 * The note text one checkpoint fact carries: its moment, then the five parts as JSON.
 *
 * Why one text shape: a later session or harness reads these facts back from the board, so claim, submit, exit stop and handoff share a single reader.
 *
 * @param {string} moment One of CHECKPOINT_MOMENTS.
 * @param {ReturnType<typeof buildCheckpoint>} fact The checkpoint from buildCheckpoint.
 * @returns {string}
 */
export function checkpointText(moment, fact) {
  return `Checkpoint at ${moment}: ${JSON.stringify(fact)}`;
}

/**
 * Read a checkpoint fact's text back into its moment and five parts, or null when the text is not a checkpoint.
 *
 * @param {string} text A fact's text.
 * @returns {{ moment: string, fact: ReturnType<typeof buildCheckpoint> } | null}
 */
export function readCheckpoint(text) {
  const found = /^Checkpoint at (claim|submit|exit-stop|handoff): (\{.*\})$/su.exec(String(text));
  if (!found) return null;
  try { return { moment: found[1], fact: buildCheckpoint(JSON.parse(found[2])) }; } catch { return null; }
}
