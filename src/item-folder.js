/** Per-item Git worktrees for a joined seat [B5,C7]. */
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { agentAt } from '../packages/store/index.js';
import { getItem } from '../packages/store/index.js';
import { Refused } from '../packages/kernel/index.js';
import { archiveMaintenanceWorktree } from './worktree-maintenance-archive.js';
import { maintenanceArchiveMatches } from './worktree-maintenance-archive.js';
import { git } from '../packages/git/index.js';
import { tryGit } from '../packages/git/index.js';
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
    const status = tryGit(path, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']);
    if (status.status !== 0 || status.stdout) continue;
    git(ctx.info.root, ['worktree', 'remove', path]);
    if (item.item_status === 'withdrawn' || item.item_merged_commit) tryGit(ctx.info.root, ['branch', '-d', ref]);
  }
}

/** Locate the exact branch checkout from Git's NUL-delimited registry, including spaced paths. */
function branchCheckout(root, ref) {
  const rows = git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0');
  for (const row of rows) {
    const fields = row.split('\0');
    if (!fields.includes(`branch refs/heads/${ref}`)) continue;
    return { path: fields.find(field => field.startsWith('worktree '))?.slice(9),
      locked: fields.some(field => field === 'locked' || field.startsWith('locked ')) };
  }
  return null;
}

/** Recover only a registered prior seat's own folder; archive and publish recovery before deletion. */
async function recoverPriorFolder(ctx, me, id, desired, ref, { board, onArchive }) {
  const tree = branchCheckout(ctx.info.root, ref);
  if (!tree || tree.path === desired) return;
  const suffix = `-item-${id}`;
  if (!board || !tree.path?.endsWith(suffix) || tree.locked) throw new Error(`item branch ${ref} remains in protected folder ${tree.path}`);
  const holder = agentAt(board, tree.path.slice(0, -suffix.length));
  if (!holder || folder(holder.agent_path, id) !== tree.path) throw new Error(`item folder ${tree.path} has no registered prior holder; retained`);
  /** Recheck ownership after every asynchronous archive notification, before touching the checkout. */
  const requireOwnership = () => {
    const item = getItem(board, id);
    if (item.item_status === 'claimed' && item.item_owner === holder.agent_id) throw new Refused('HELD', `${holder.agent_id} still claims #${id} in ${tree.path}; its folder is retained`);
    if (item.item_status !== 'claimed' || item.item_owner !== me.id) throw new Refused('ITEM_LEASE_LOST', `claim #${id} changed before recovering ${tree.path}; its folder is retained`);
    const common = tryGit(tree.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const actual = tryGit(tree.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (common.status !== 0 || common.stdout !== ctx.info.commonDir || actual.status !== 0 || actual.stdout !== ref) throw new Error(`item folder ${tree.path} changed repository or branch; retained`);
  };
  requireOwnership();
  const status = tryGit(tree.path, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']);
  if (status.status !== 0) throw new Error(`cannot inspect prior item folder ${tree.path}; retained`);
  if (status.stdout) {
    if (typeof onArchive !== 'function') throw new Error('a dirty item folder needs a native recovery note before removal');
    const archive = archiveMaintenanceWorktree(tree.path, ctx.info.commonDir, { includeMetadata: true });
    await onArchive({ ...archive, previousPath: tree.path, previousHolder: holder.agent_id });
    requireOwnership();
    if (!maintenanceArchiveMatches(tree.path, archive)) throw new Error(`prior item folder ${tree.path} changed after archive; retained`);
    git(ctx.info.root, ['worktree', 'remove', '--force', tree.path]);
  } else {
    requireOwnership();
    git(ctx.info.root, ['worktree', 'remove', tree.path]);
  }
}

/** Open or reuse this item's branch, starting a new branch at the current primary main. */
export async function openItemFolder(ctx, me, id, options = {}) {
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
  if (exists) await recoverPriorFolder(ctx, me, id, path, ref, options);
  git(root, exists ? ['worktree', 'add', path, ref] : ['worktree', 'add', '-b', ref, path, 'main']);
  return path;
}
