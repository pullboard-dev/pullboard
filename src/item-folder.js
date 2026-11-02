/** Per-item Git worktrees for a joined seat [B5,C7]. */
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { git, tryGit } from './git.js';
import { primaryCheckoutRoot } from './cli/worktree.js';

/** A seat's folders are siblings of its checkout, never inside its working tree. */
function folder(root, id) { return join(dirname(root), `${basename(root)}-item-${id}`); }
function branch(lane, id) { return `${lane}/item-${id}`; }

/** Remove only clean worktrees with the exact seat path and item branch we created. */
export function cleanItemFolders(ctx, board, me, items) {
  if (me.id === 'coordinator') return;
  for (const item of items(board, { all: true })) {
    const path = folder(ctx.info.root, item.item_id);
    if (!existsSync(path) || (item.item_status === 'claimed' && item.item_owner === me.id) || item.item_status === 'submitted') continue;
    const ref = branch(me.lane, item.item_id);
    const actual = tryGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const common = tryGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (actual.status !== 0 || actual.stdout !== ref || common.status !== 0 || common.stdout !== ctx.info.commonDir) continue;
    const status = tryGit(path, ['status', '--porcelain', '--untracked-files=all']);
    if (status.status !== 0 || status.stdout) continue;
    git(ctx.info.root, ['worktree', 'remove', path]);
    if (item.item_status === 'withdrawn' || item.item_merged_commit) tryGit(ctx.info.root, ['branch', '-d', ref]);
  }
}

/** Open or reuse this item's branch, starting a new branch at the current primary main. */
export function openItemFolder(ctx, me, id) {
  if (me.id === 'coordinator') return null;
  const root = ctx.info.root, path = folder(root, id), ref = branch(me.lane, id);
  if (existsSync(path)) {
    const actual = tryGit(path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    const common = tryGit(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (actual.status !== 0 || actual.stdout !== ref || common.status !== 0 || common.stdout !== ctx.info.commonDir) throw new Error(`item folder ${path} is occupied by another checkout`);
    return path;
  }
  const main = primaryCheckoutRoot(ctx.info);
  if (!main) throw new Error('cannot locate the primary checkout for the item folder');
  const exists = tryGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`]).status === 0;
  git(root, exists ? ['worktree', 'add', path, ref] : ['worktree', 'add', '-b', ref, path, 'main']);
  return path;
}
