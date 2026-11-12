/** Pure validation of the ids the pin cell accepts [C7]. */

/**
 * Tell whether a string is a full git object id (40 or 64 hex digits).
 *
 * Why: tree ids name bundle files, so anything else could escape the bundle folder.
 *
 * @param {unknown} id - The candidate id.
 * @returns {boolean} True for a full lowercase hex object id.
 */
export function isObjectId(id) {
  return typeof id === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(id);
}

/**
 * Name the bundle file for a tree id.
 *
 * @param {string} tree - A full tree id.
 * @returns {string} The file name, keyed by tree id alone.
 */
export function bundleName(tree) {
  return `${tree}.tar`;
}
