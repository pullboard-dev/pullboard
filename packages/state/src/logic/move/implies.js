/** Pure feature detection without board/query dependencies [H16,C7]. */
/** The operations whose sealed options may carry `implies`. */
export const IMPLYING_OPERATIONS = Object.freeze(['appendFact', 'answerDecision', 'verify']);

/**
 * True when a sealed move carries this engine's meaning: items it implies, or an answer it supersedes.
 * The relay refuses such a move from an older engine before it changes any board.
 *
 * @param {string} operation
 * @param {any[]} args
 * @returns {boolean}
 */
export function carriesImplies(operation, args) {
  const options = args?.[1];
  if (!IMPLYING_OPERATIONS.includes(operation) || !options || typeof options !== 'object') return false;
  return (Array.isArray(options.implies) && options.implies.length > 0)
    || (operation === 'answerDecision' && options.supersedes !== undefined && options.supersedes !== null);
}
