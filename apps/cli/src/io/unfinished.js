/** Item folders left holding an unfinished merge, rebase or cherry-pick: named, never archived or crashed on [B3,C7]. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The operation a checkout was left in the middle of, or null when it holds none. Unmerged index entries are an
 * unfinished operation even when Git kept no marker for it; the marker names which one.
 *
 * @param {string} path the checkout
 * @param {(cwd: string, args: string[]) => { status: number, stdout: string }} tryGit the caller's Git reader
 * @returns {'merge'|'rebase'|'cherry-pick'|null}
 */
export function unfinishedOperation(path, tryGit) {
  if (!existsSync(path)) return null;
  const dir = tryGit(path, ['rev-parse', '--absolute-git-dir']);
  if (dir.status !== 0) return null;
  const marked = name => existsSync(join(dir.stdout, name));
  if (marked('rebase-merge') || marked('rebase-apply')) return 'rebase';
  if (marked('CHERRY_PICK_HEAD')) return 'cherry-pick';
  if (marked('MERGE_HEAD')) return 'merge';
  const unmerged = tryGit(path, ['ls-files', '--unmerged']);
  return unmerged.status === 0 && unmerged.stdout ? 'merge' : null;
}

/**
 * The refusal message for an item folder left mid-operation: the folder, the operation and the item. The folder is only
 * read, because recovering it would archive an unresolved index, which maintenance cannot do.
 *
 * @param {string} path the item folder
 * @param {number} id the item
 * @param {string} operation from unfinishedOperation
 * @returns {string}
 */
export function unfinishedFolderMessage(path, id, operation) {
  return `item folder ${path} for #${id} holds an unfinished ${operation}; it is retained untouched. The coordinator finishes or aborts the ${operation} there, or the seat continues in a folder of its own`;
}

/**
 * Every item folder among `paths` holding an unfinished operation, with its seat and item, so the coordinator can clear it.
 *
 * @param {string[]} paths registered worktree paths
 * @param {Map<string, string>} seats seat id by seat checkout path
 * @param {Function} tryGit the caller's Git reader
 * @returns {{ path: string, operation: string, item: number, seat: string|null }[]}
 */
export function unfinishedItemFolders(paths, seats, tryGit) {
  const rows = [];
  for (const path of paths) {
    const match = /-item-([1-9]\d*)$/u.exec(path);
    const operation = match && unfinishedOperation(path, tryGit);
    if (operation) rows.push({ path, operation, item: Number(match[1]), seat: seats.get(path.slice(0, match.index)) ?? null });
  }
  return rows;
}
