/** Where the search sidecar lives; no file is written here [C7]. */
import { join } from 'node:path';
import { resolve } from 'node:path';

/**
 * Where the sidecar lives for a checkout: under the shared git directory, so every worktree reads one index.
 *
 * @param {string} root - The checkout root.
 * @param {string} commonDir - The shared git directory, as the project info names it.
 * @returns {string}
 */
export function searchSidecarPath(root, commonDir) {
  return join(resolve(root, commonDir), 'pullboard', 'search', 'tfidf.index');
}
