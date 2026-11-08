/** Per-item Git worktrees for a joined seat [B5,C7]. */
import { existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { agentAt } from '../../../../packages/store/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { Refused } from '../../../../packages/kernel/index.js';
import { archiveMaintenanceWorktree } from './worktree-maintenance-archive.js';
import { maintenanceArchiveMatches } from './worktree-maintenance-archive.js';
import { git } from '../../../../packages/git/index.js';
import { tryGit } from '../../../../packages/git/index.js';
import { checkoutBranch } from '../../../../packages/git/index.js';
import { checkoutCommonDir } from '../../../../packages/git/index.js';
import { primaryCheckoutRoot } from './cli/worktree.js';
import { writeItemMarker } from './item-folder-identity.js';
export { itemFolderIdentity, itemFolderPath } from './item-folder-identity.js';
import { itemFolderPath } from './item-folder-identity.js';
import { seatRoot } from './item-folder-identity.js';
import { itemFolderRunner } from './commands/runner.js';
import { openHostedItemFolder } from './commands/runner.js';

/** The item's branch in the seat's lane. */
function branch(lane, id) { return `${lane}/item-${id}`; }

/** The item ids of this seat's folders beside its checkout, read from one directory listing. */
function seatFolderIds(root) {
  const prefix = `${basename(root)}-item-`;
  let names;
  try { names = readdirSync(dirname(root)); } catch { return []; }
  return names.filter(name => name.startsWith(prefix) && /^[1-9]\d*$/u.test(name.slice(prefix.length))).map(name => Number(name.slice(prefix.length)));
}

/** The real path of a folder, or null when it vanished or is a dangling link, so cleanup skips it. */
function canonical(path) {
  try { return realpathSync(path); } catch { return null; }
}

/**
 * Map each registered worktree path to its branch and commit, from one Git launch for the whole repository.
 * @param {string} root The repository root.
 * @returns {Map<string, string> & { commits: Map<string, string>, mainCommit: string|null }} Branch by path, with each path's commit and main's commit when main is checked out.
 */
function worktreeBranches(root) {
  const branches = new Map();
  branches.commits = new Map();
  branches.mainCommit = null;
  for (const row of git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0')) {
    const fields = row.split('\0');
    const path = fields.find(field => field.startsWith('worktree '))?.slice(9);
    const head = fields.find(field => field.startsWith('branch refs/heads/'))?.slice(18);
    const commit = fields.find(field => field.startsWith('HEAD '))?.slice(5);
    if (head === 'main' && commit) branches.mainCommit = commit;
    if (path && head) branches.set(path, head);
    if (path && commit) branches.commits.set(path, commit);
  }
  return branches;
}

/**
 * Whether the item's branch has a commit main lacks and the item is neither merged nor withdrawn, so its folder is the only checkout of that work [C7].
 * A folder whose commit is main's own commit holds nothing unlanded, so the common clean folder costs no extra Git launch.
 * @param {string} root The repository root.
 * @param {object} item The board item.
 * @param {string} ref The item branch.
 * @param {string|undefined} commit The folder's commit from the worktree list.
 * @param {string|null} mainCommit Main's commit from the same worktree list.
 * @returns {boolean} True when the folder must be kept.
 */
function holdsUnlandedWork(root, item, ref, commit, mainCommit) {
  if (item.item_status === 'withdrawn' || item.item_merged_commit) return false;
  if (commit && mainCommit && commit === mainCommit) return false;
  const ahead = tryGit(root, ['rev-list', '--count', `main..${ref}`]);
  return ahead.status !== 0 || Number(ahead.stdout) > 0;
}

/**
 * Remove only clean worktrees with the exact seat path and item branch we created.
 * The seat is resolved once and only this seat's existing folders are read, so a board with
 * thousands of items costs one directory listing, one worktree list and one status per folder.
 */
export function cleanItemFolders(ctx, board, me) {
  if (me.id === 'coordinator') return;
  const root = seatRoot(ctx, board, me);
  let branches = null;
  for (const id of seatFolderIds(root)) {
    let item;
    try { item = getItem(board, id); } catch { continue; }
    if (!item || (item.item_status === 'claimed' && item.item_owner === me.id) || item.item_status === 'submitted') continue;
    const path = itemFolderPath(root, id), ref = branch(me.lane, id);
    branches ??= worktreeBranches(ctx.info.root);
    if ((branches.get(path) ?? branches.get(canonical(path))) !== ref) continue;
    const status = tryGit(path, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']);
    if (status.status !== 0 || status.stdout) continue;
    const commit = branches.commits.get(path) ?? branches.commits.get(canonical(path));
    if (holdsUnlandedWork(ctx.info.root, item, ref, commit, branches.mainCommit)) continue;
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

/**
 * Adopt or recover the folder that holds this item's branch at another seat's path.
 * A clean folder (no tracked or untracked changes) is moved to the new seat path with git worktree move, keeping its
 * commits, Git metadata and ignored files, whether its seat ended or was never registered (#3540). A dirty folder of a
 * registered prior seat is archived and its recovery published before deletion; a dirty unregistered one is retained.
 *
 * @param {any} ctx
 * @param {{ id: string }} me the claiming seat
 * @param {number} id the item
 * @param {string} desired this seat's item folder path
 * @param {string} ref the item branch
 * @param {{ board?: any, onArchive?: Function }} options
 * @returns {Promise<boolean>} true when the prior folder was moved to `desired`
 */
async function recoverPriorFolder(ctx, me, id, desired, ref, { board, onArchive }) {
  const tree = branchCheckout(ctx.info.root, ref);
  if (!tree || tree.path === desired) return false;
  const suffix = `-item-${id}`;
  if (!board || !tree.path?.endsWith(suffix) || tree.locked) throw new Refused('ITEM_FOLDER_PROTECTED', `item branch ${ref} remains in protected folder ${tree.path}; the coordinator archives or removes that folder, or continue in a folder of your own`);
  const found = agentAt(board, tree.path.slice(0, -suffix.length));
  const holder = found && itemFolderPath(found.agent_path, id) === tree.path ? found : null;
  /** Recheck ownership after every asynchronous archive notification, before touching the checkout. */
  const requireOwnership = () => {
    const item = getItem(board, id);
    if (holder && item.item_status === 'claimed' && item.item_owner === holder.agent_id) throw new Refused('HELD', `${holder.agent_id} still claims #${id} in ${tree.path}; its folder is retained`);
    if (item.item_status !== 'claimed' || item.item_owner !== me.id) throw new Refused('ITEM_LEASE_LOST', `claim #${id} changed before recovering ${tree.path}; its folder is retained`);
    const common = tryGit(tree.path, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    const actual = tryGit(tree.path, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (common.status !== 0 || common.stdout !== ctx.info.commonDir || actual.status !== 0 || actual.stdout !== ref) throw new Error(`item folder ${tree.path} changed repository or branch; retained`);
  };
  requireOwnership();
  const changes = tryGit(tree.path, ['status', '--porcelain', '--untracked-files=all']);
  if (changes.status !== 0) throw new Error(`cannot inspect prior item folder ${tree.path}; retained`);
  if (!changes.stdout) {
    // The session module loads only when a folder is adopted, keeping claim's import graph unchanged.
    const session = await import('./cli/join.js');
    const prior = session.endedItemFolderSession(board, me, tree.path);
    // Adopt: a move keeps the branch's commits and the folder itself, so nothing the ended seat left is lost (#3540).
    git(ctx.info.root, ['worktree', 'move', tree.path, desired]);
    await session.adoptItemFolderSession(desired, me, prior);
    return true;
  }
  // A dirty folder is archived only once its holder's session has ended; a live session keeps it and is named (#3720).
  (await import('./cli/join.js')).endedItemFolderSession(board, me, tree.path);
  if (!holder) throw new Refused('ITEM_FOLDER_UNREGISTERED', `item folder ${tree.path} has uncommitted changes and no registered prior holder; it is retained. The coordinator archives or removes the folder, or the seat continues in its own folder`);
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
  return false;
}

/**
 * The ITEM_FOLDER_SESSION_LIVE refusal claiming this item's folder would meet, or null, read without moving, binding or
 * creating anything (#3688). Why: next claimed first and opened the folder after, so a folder another live session holds
 * refused every next on the same item; next asks this before claiming and selects another item instead.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string, lane: string }} me the seat about to claim
 * @param {number} id the item
 * @returns {Promise<Refused|null>}
 */
export async function liveFolderRefusal(ctx, board, me, id) {
  if (me.id === 'coordinator') return null;
  const path = itemFolderPath(seatRoot(ctx, board, me), id);
  const folder = existsSync(path) ? path : branchCheckout(ctx.info.root, branch(me.lane, id))?.path;
  if (!folder || !existsSync(folder)) return null;
  const session = await import('./cli/join.js');
  try { session.endedItemFolderSession(board, me, folder); return null; }
  catch (error) {
    if (error instanceof Refused && error.code === 'ITEM_FOLDER_SESSION_LIVE') return error;
    throw error;
  }
}

/** Whether two paths name one existing directory, however each was spelled. */
function sameDirectory(first, second) {
  try { return first !== null && realpathSync(first) === realpathSync(second); } catch { return false; }
}

/** Open or reuse this item's branch, starting a new branch at the current primary main; a runner-hosted seat's folder lives only on its runner [C7]. */
export async function openItemFolder(ctx, me, id, options = {}) {
  if (me.id === 'coordinator') return null;
  const runner = itemFolderRunner();
  if (runner) {
    const hooks = tryGit(ctx.info.root, ['config', '--get', 'core.hooksPath']);
    return openHostedItemFolder(runner, { itemId: id, branch: branch(me.lane, id), commonDir: ctx.info.commonDir,
      hooksPath: hooks.status === 0 ? hooks.stdout : undefined });
  }
  const root = ctx.info.root, path = itemFolderPath(seatRoot(ctx, options.board, me), id), ref = branch(me.lane, id);
  if (existsSync(path)) {
    if (checkoutBranch(path) !== ref || !sameDirectory(checkoutCommonDir(path), ctx.info.commonDir)) throw new Error(`item folder ${path} is occupied by another checkout`);
    if (!options.renewed) {
      const status = tryGit(path, ['status', '--porcelain', '--untracked-files=all']);
      if (status.status !== 0) throw new Error(`cannot inspect item folder ${path}; preserve it and retry`);
      const dirty = status.stdout.split('\n').filter(Boolean).map(line => line.slice(3));
      if (dirty.length) throw new Refused('ITEM_FOLDER_DIRTY', `item folder ${path} has dirty files ${dirty.join(', ')}; preserve or recover them before claiming again`);
    }
    // The folder may still be bound to an ended session of this seat path: the claimer takes it over (#3679).
    const session = await import('./cli/join.js');
    await session.adoptItemFolderSession(path, me, session.endedItemFolderSession(options.board, me, path));
    writeItemMarker(path, me.id, id);
    return path;
  }
  const main = primaryCheckoutRoot(ctx.info);
  if (!main) throw new Error('cannot locate the primary checkout for the item folder');
  const exists = tryGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`]).status === 0;
  if (exists && await recoverPriorFolder(ctx, me, id, path, ref, options)) {
    writeItemMarker(path, me.id, id);
    return path;
  }
  git(root, exists ? ['worktree', 'add', path, ref] : ['worktree', 'add', '-b', ref, path, 'main']);
  writeItemMarker(path, me.id, id);
  return path;
}
