/** Where the code map's derived caches live, so a module that only reads or writes one cache file need not name the board folder [C7]. */
import { join } from 'node:path';

/**
 * The board's private folder in the common git dir, where code-map.json and the per-item slice cache sit.
 *
 * @param {string} commonDir - The repository's common git dir.
 * @returns {string}
 */
export function codeMapHome(commonDir) {
  return join(commonDir, 'pullboard');
}
