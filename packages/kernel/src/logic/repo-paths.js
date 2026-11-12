import { join } from 'node:path';

/**
 * A file or folder inside a repository, named by one repository-relative path string.
 * Code that builds a repository path from several segments hides the path from the layout freeze, which rewrites whole
 * path strings; naming the path once keeps every such place findable and movable [C7].
 *
 * @param {string} root The repository (or worktree) root.
 * @param {string} relative Slash-separated path below the root, for example 'packages/gate/data/ceilings/cells-edges.json'.
 * @returns {string} The path under `root`, written with the platform separator.
 */
export function repoPath(root, relative) {
  return join(root, ...String(relative).split('/').filter(Boolean));
}
