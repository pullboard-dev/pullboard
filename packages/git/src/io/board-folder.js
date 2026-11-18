/** The board's private folder under the repository's common Git directory: one path helper, so a store's owner never spells the folder itself [C7]. */
import { join } from 'node:path';
import { repoInfo } from './main.js';

/**
 * Where a named file lives in the board's private folder, shared by every worktree of the repository.
 *
 * @param {string} root - Repository or worktree root.
 * @param {string} name - The store's file name.
 * @returns {string} The absolute path.
 */
export function boardFolderFile(root, name) {
  return commonBoardFolderFile(repoInfo(root).commonDir, name);
}

/**
 * The same path when the caller already holds the common Git directory, so it spawns no Git.
 *
 * @param {string} commonDir - The repository's common Git directory.
 * @param {string} name - The store's file name.
 * @returns {string} The absolute path.
 */
export function commonBoardFolderFile(commonDir, name) {
  return join(commonDir, 'pullboard', name);
}
