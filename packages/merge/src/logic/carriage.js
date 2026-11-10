/** Which sealed move arguments carry a trunk conflict, readable without the merge shell [B3,D1,C7]. */

/**
 * True when a sealed move carries this engine's meaning, a trunk conflict on a reopen.
 *
 * @param {string} operation
 * @param {any[]} args
 * @returns {boolean}
 */
export function carriesConflict(operation, args) {
  return operation === 'reopen' && args?.[1]?.conflict !== undefined && args?.[1]?.conflict !== null;
}
