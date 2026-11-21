/** Per-item Git worktrees for a joined seat [B5,C7]. */
import { environmentAdapter } from '../../../../../packages/env/index.js';
import { basename } from 'node:path';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentAt } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { Refused } from '../../../../../packages/kernel/index.js';
import { archiveOrRefuse } from '../worktree/maintenance/archive.js';
import { maintenanceArchiveMatches } from '../worktree/maintenance/archive.js';
import { git } from '../../../../../packages/git/index.js';
import { tryGit } from '../../../../../packages/git/index.js';
import { checkoutBranch } from '../../../../../packages/git/index.js';
import { checkoutCommonDir } from '../../../../../packages/git/index.js';
import { checkoutHead } from '../../../../../packages/git/index.js';
import { checkoutRefCommit } from '../../../../../packages/git/index.js';
import { trunkRef } from '../../../../../packages/sandbox/index.js';
import { primaryCheckoutRoot } from '../worktree.js';
import { unfinishedFolderMessage } from '../unfinished.js';
import { unfinishedItemFolders } from '../unfinished.js';
import { unfinishedOperation } from '../unfinished.js';
import { writeItemMarker } from './folder/identity.js';
export { itemFolderIdentity, itemFolderPath } from './folder/identity.js';
import { itemFolderPath } from './folder/identity.js';
import { seatRoot } from './folder/identity.js';
import { prepareSpareFolder } from './folder/spare.js';
import { takeSpareFolder } from './folder/spare.js';
import { fileSystemAdapter } from '../../../../../packages/fs/index.js';

const fs = fileSystemAdapter();

/** Git selectors an inherited environment may set; any of them means the config files alone do not say what Git reads. */
const CONFIG_SELECTORS = ['GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_SYSTEM', 'GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE'];
/** The system config files Git builds on this machine read, since none can be asked without a launch. */
const SYSTEM_CONFIGS = ['/etc/gitconfig', '/opt/homebrew/etc/gitconfig', '/usr/local/etc/gitconfig',
  '/Library/Developer/CommandLineTools/usr/etc/gitconfig', '/Applications/Xcode.app/Contents/Developer/usr/etc/gitconfig'];

/**
 * Read one Git config file for checkout.workers: whether it sets it, and whether it turns on per-worktree config.
 * An include directive or an unreadable file returns null, since only Git can say what those mean.
 * @param {string} file
 * @returns {{ workers: boolean, worktreeConfig: boolean } | null}
 */
function configFacts(file) {
  let text;
  try { text = fs.readFile(file, 'utf8'); } catch (error) { return ['ENOENT', 'ENOTDIR'].includes(error.code) ? { workers: false, worktreeConfig: false } : null; }
  const facts = { workers: false, worktreeConfig: false };
  let section = '';
  for (const raw of text.split(/\r?\n/u)) {
    let line = raw.trim();
    const header = /^\[\s*([A-Za-z0-9.-]+)(\s+"(?:[^"\\]|\\.)*")?\s*\](.*)$/u.exec(line);
    if (header) {
      const name = header[1].toLowerCase();
      if (name === 'include' || name === 'includeif') return null;
      // A quoted subsection is never the plain checkout or extensions section.
      section = header[2] ? '' : name;
      line = header[3].trim();
    }
    if (section === 'checkout' && /^workers\s*(=|$|[#;])/iu.test(line)) facts.workers = true;
    if (section === 'extensions' && /^worktreeconfig\s*(=\s*(true|yes|on|1)\b|$)/iu.test(line)) facts.worktreeConfig = true;
  }
  return facts;
}

/**
 * Whether the GIT_CONFIG_COUNT pairs in the environment set checkout.workers: Git reads GIT_CONFIG_KEY_n and GIT_CONFIG_VALUE_n as its highest-priority config,
 * and test and agent environments carry them (gc.auto, user.useConfigOnly), so they are read here instead of asking Git [C7,#5329].
 * A count that is not a non-negative integer, a missing key, or a key that turns on per-worktree config returns null, since only Git can say what those mean.
 * @param {NodeJS.ProcessEnv} env
 * @returns {boolean | null}
 */
function workersSetInEnvironment(env) {
  if (env.GIT_CONFIG_COUNT === undefined) return false;
  if (!/^\d+$/u.test(env.GIT_CONFIG_COUNT)) return null;
  let found = false;
  for (let index = 0; index < Number(env.GIT_CONFIG_COUNT); index += 1) {
    const key = env[`GIT_CONFIG_KEY_${index}`]?.toLowerCase();
    if (key === undefined || key === 'extensions.worktreeconfig') return null;
    found ||= key === 'checkout.workers';
  }
  return found;
}

/**
 * Whether the repository's own config files set checkout.workers, read with no Git launch; null when only Git can say.
 * @param {string} root any checkout of the repository
 * @returns {boolean | null}
 */
function workersSetInFiles(root) {
  const env = environmentAdapter().all();
  if (CONFIG_SELECTORS.some(key => env[key] !== undefined)) return null;
  const fromEnvironment = workersSetInEnvironment(env);
  if (fromEnvironment === null) return null;
  let gitDir = join(root, '.git');
  try {
    if (!fs.stat(gitDir).isDirectory()) {
      const match = /^gitdir:\s*(.+)$/u.exec(fs.readFile(gitDir, 'utf8').trim());
      if (!match) return null;
      gitDir = resolve(root, match[1].trim());
    }
    const commonFile = join(gitDir, 'commondir');
    const commonDir = fs.exists(commonFile) ? resolve(gitDir, fs.readFile(commonFile, 'utf8').trim()) : gitDir;
    const home = env.HOME ?? '';
    const global = env.GIT_CONFIG_GLOBAL !== undefined ? [env.GIT_CONFIG_GLOBAL]
      : [join(env.XDG_CONFIG_HOME || join(home, '.config'), 'git', 'config'), join(home, '.gitconfig')];
    const files = [...(env.GIT_CONFIG_NOSYSTEM ? [] : SYSTEM_CONFIGS), ...global, join(commonDir, 'config')];
    const local = configFacts(join(commonDir, 'config'));
    if (!local) return null;
    // Git reads a worktree's own config only when the repository turns it on.
    if (local.worktreeConfig) files.push(join(gitDir, 'config.worktree'));
    let found = false;
    for (const file of files) {
      const facts = file === join(commonDir, 'config') ? local : configFacts(file);
      if (!facts) return null;
      found ||= facts.workers;
    }
    return found || fromEnvironment;
  } catch { return null; }
}

/**
 * Git config arguments that write a checkout's files with parallel workers, one per core, unless the repository sets its own count.
 * Why: a sequential worktree add wrote this repository's 4,595 files in 2.4-4.3 s, most of a claiming next; parallel workers took 0.9 s [C7,#5776].
 * The setting is read from the config files, since asking Git cost a median 21.5 ms per claim; an include directive or an unreadable file asks Git [C7,#5329].
 * @param {string} root any checkout of the repository
 * @returns {string[]}
 */
export function parallelCheckout(root) {
  const set = workersSetInFiles(root) ?? tryGit(root, ['config', '--get', 'checkout.workers']).status === 0;
  return set ? [] : ['-c', 'checkout.workers=0'];
}

/** The item's branch in the seat's lane. */
function branch(lane, id) { return `${lane}/item-${id}`; }

/** The item ids of this seat's folders beside its checkout, read from one directory listing. */
function seatFolderIds(root) {
  const prefix = `${basename(root)}-item-`;
  let names;
  try { names = fs.list(dirname(root)); } catch { return []; }
  return names.filter(name => name.startsWith(prefix) && /^[1-9]\d*$/u.test(name.slice(prefix.length))).map(name => Number(name.slice(prefix.length)));
}

/** The real path of a folder, or null when it vanished or is a dangling link, so cleanup skips it. */
function canonical(path) {
  try { return fs.realpath(path); } catch { return null; }
}

/** The trunk branch read once per root for the life of the process, so one claim runs git config pullboard.trunk once [C7]. */
const trunkBranches = new Map();

/**
 * The project's configured trunk branch, or main when none is recorded.
 * Why: a project whose trunk is master or trunk had claim fail on a hard-coded main [C7,#3759].
 * @param {string} root any checkout of the repository
 * @returns {string}
 */
export function trunkBranch(root) {
  const known = trunkBranches.get(root);
  if (known) return known;
  let configured = null;
  try { configured = trunkRef(root); } catch { /* An unreadable trunk setting reads as unset. */ }
  const trunk = typeof configured === 'string' && configured.trim() ? configured.trim().replace(/^refs\/heads\//u, '') : 'main';
  trunkBranches.set(root, trunk);
  return trunk;
}

/**
 * Map each registered worktree path to its branch and commit, from one Git launch for the whole repository.
 * @param {string} root The repository root.
 * @returns {Map<string, string> & { commits: Map<string, string>, mainCommit: string|null }} Branch by path, with each path's commit and main's commit when main is checked out.
 */
function worktreeBranches(root) {
  const trunk = trunkBranch(root);
  const branches = new Map();
  branches.commits = new Map();
  branches.mainCommit = null;
  for (const row of git(root, ['worktree', 'list', '--porcelain', '-z']).split('\0\0')) {
    const fields = row.split('\0');
    const path = fields.find(field => field.startsWith('worktree '))?.slice(9);
    const head = fields.find(field => field.startsWith('branch refs/heads/'))?.slice(18);
    const commit = fields.find(field => field.startsWith('HEAD '))?.slice(5);
    if (head === trunk && commit) branches.mainCommit = commit;
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
 * Whether the seat's folder for an item is idle: clean down to ignored files, on the seat's own item branch, with nothing unlanded [C7].
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string, lane: string }} me the seat
 * @param {string} root the seat checkout
 * @param {number} id the item the folder was made for
 * @param {() => ReturnType<typeof worktreeBranches>} registry The lazy worktree list shared by one pass.
 * @returns {{ item: object, path: string, ref: string }|null} The idle folder, or null when it must be kept in place.
 */
function idleFolder(ctx, board, me, root, id, registry) {
  let item;
  try { item = getItem(board, id); } catch { return null; }
  if (!item || (item.item_status === 'claimed' && item.item_owner === me.id) || item.item_status === 'submitted') return null;
  const path = itemFolderPath(root, id), ref = branch(me.lane, id);
  const branches = registry();
  if ((branches.get(path) ?? branches.get(canonical(path))) !== ref) return null;
  const status = tryGit(path, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']);
  if (status.status !== 0 || status.stdout) return null;
  const commit = branches.commits.get(path) ?? branches.commits.get(canonical(path));
  if (holdsUnlandedWork(ctx.info.root, item, ref, commit, branches.mainCommit)) return null;
  return { item, path, ref };
}

/**
 * Remove only clean worktrees with the exact seat path and item branch we created.
 * The seat is resolved once and only this seat's existing folders are read, so a board with
 * thousands of items costs one directory listing, one worktree list and one status per folder.
 * With `spare`, the first idle folder is kept so the seat's next claim switches it to that item instead of creating a worktree [C7].
 */
export function cleanItemFolders(ctx, board, me, { spare = false } = {}) {
  if (me.id === 'coordinator') return;
  const root = seatRoot(ctx, board, me);
  let branches = null;
  const registry = () => (branches ??= worktreeBranches(ctx.info.root));
  let spared = !spare;
  for (const id of seatFolderIds(root)) {
    const idle = idleFolder(ctx, board, me, root, id, registry);
    if (!idle) continue;
    if (!spared) { spared = true; continue; }
    const dropBranch = idle.item.item_status === 'withdrawn' || Boolean(idle.item.item_merged_commit);
    removeIdleFolder(ctx.info.root, idle.path, { seat: root, ref: dropBranch ? idle.ref : null, running: [ctx.info.root, runningCheckout()] });
  }
}

/** Where main() keeps the folder removals it runs after its last step; absent outside a running command. */
export const DEFERRED_FOLDER_REMOVALS = Symbol.for('pullboard.deferred-folder-removals');

/** The checkout this CLI's own modules load from, resolved once (apps/cli/src/io/item/ sits five levels below it). */
let ownCheckout;
function runningCheckout() {
  return (ownCheckout ??= canonical(fileURLToPath(new URL('../../../../../', import.meta.url))));
}

/**
 * Remove one idle item folder, or, while a command runs from inside it, leave it until main() finishes.
 * Why: release removed the folder the agent stood in, and when that folder held the CLI it ran, every later lazy
 * import resolved into a deleted tree: the release recorded, then Node crashed ERR_MODULE_NOT_FOUND (#10891).
 *
 * @param {string} gitRoot the checkout the command runs git in
 * @param {string} path the clean item folder to remove
 * @param {{ seat: string, ref?: string|null, running?: (string|null)[] }} options the seat checkout that survives,
 *   the item branch to delete after removal, and the folders the running command stands in or loads from
 * @returns {boolean} true when the folder was removed now, false when its removal waits for main() to finish
 */
export function removeIdleFolder(gitRoot, path, { seat, ref = null, running = [] }) {
  const pending = globalThis[DEFERRED_FOLDER_REMOVALS];
  const here = canonical(path);
  const inside = here !== null && running.some(folder => {
    const real = folder ? canonical(folder) : null;
    return real !== null && (real === here || real.startsWith(here + '/'));
  });
  if (Array.isArray(pending) && inside) {
    // Run from the seat, which survives, never from the folder being removed.
    pending.push(() => {
      tryGit(seat, ['worktree', 'remove', path]);
      if (ref) tryGit(seat, ['branch', '-d', ref]);
    });
    return false;
  }
  git(gitRoot, ['worktree', 'remove', path]);
  if (ref) tryGit(gitRoot, ['branch', '-d', ref]);
  return true;
}

/**
 * Switch this seat's own idle item folder to the new item instead of creating a worktree [C7].
 * Why: a worktree per claim wrote every tracked file again and left the folders to be deleted later; a move and a branch
 * switch rewrite only the files that differ. A dirty folder, one with unlanded work, or one a live session holds is never touched.
 *
 * @param {any} ctx
 * @param {{ id: string, lane: string }} me the claiming seat
 * @param {number} id the new item
 * @param {string} desired the new item's folder path
 * @param {string} ref the new item's branch
 * @param {boolean} exists whether the branch already exists
 * @param {{ board?: any }} options
 * @returns {Promise<boolean>} true when an idle folder was moved to `desired` and switched to `ref`
 */
async function reuseIdleFolder(ctx, me, id, desired, ref, exists, { board }) {
  if (!board) return false;
  const root = seatRoot(ctx, board, me);
  let branches = null;
  const registry = () => (branches ??= worktreeBranches(ctx.info.root));
  for (const old of seatFolderIds(root)) {
    if (old === id) continue;
    const idle = idleFolder(ctx, board, me, root, old, registry);
    if (!idle) continue;
    const session = await import('../join.js');
    let prior;
    try { prior = session.endedItemFolderSession(board, me, idle.path); }
    catch (error) { if (error instanceof Refused) continue; throw error; }
    git(ctx.info.root, ['worktree', 'move', idle.path, desired]);
    try { git(desired, [...parallelCheckout(desired), ...(exists ? ['checkout', '-q', ref] : ['checkout', '-q', '-b', ref, trunkBranch(ctx.info.root)])]); }
    catch (error) { git(ctx.info.root, ['worktree', 'move', desired, idle.path]); throw error; }
    if (idle.item.item_status === 'withdrawn' || idle.item.item_merged_commit) tryGit(ctx.info.root, ['branch', '-d', idle.ref]);
    await session.adoptItemFolderSession(desired, me, prior);
    return true;
  }
  return false;
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
 * The same checkout branchCheckout finds, read from the registry Git keeps under the common directory, with no Git launch:
 * the primary checkout's HEAD, then worktrees/<name>/HEAD, gitdir and locked. Why: every fresh claim asked Git for the list, 23 ms median (#10862).
 */
function branchCheckoutFromFiles(commonDir, ref) {
  const read = file => { try { return fs.readFile(file, 'utf8').trim(); } catch { return null; } };
  const wanted = `ref: refs/heads/${ref}`;
  if (basename(commonDir) === '.git' && read(join(commonDir, 'HEAD')) === wanted) return { path: dirname(commonDir), locked: false };
  let names;
  try { names = fs.list(join(commonDir, 'worktrees')); } catch { return null; }
  for (const name of names) {
    const entry = join(commonDir, 'worktrees', name);
    if (read(join(entry, 'HEAD')) !== wanted) continue;
    const gitdir = read(join(entry, 'gitdir'));
    if (gitdir) return { path: dirname(gitdir), locked: fs.exists(join(entry, 'locked')) };
  }
  return null;
}

/** The ITEM_FOLDER_PROTECTED refusal for an item branch held in a locked or foreign folder, which no claim adopts. */
function protectedFolderRefusal(ref, path) {
  return new Refused('ITEM_FOLDER_PROTECTED', `item branch ${ref} remains in protected folder ${path}; the coordinator archives or removes that folder, or continue in a folder of your own`);
}

/** The ITEM_FOLDER_UNFINISHED refusal for a folder left mid-merge, rebase or cherry-pick, or null; the folder is only read (#3763). */
function unfinishedFolderRefusal(path, id) {
  const operation = unfinishedOperation(path, tryGit);
  return operation ? new Refused('ITEM_FOLDER_UNFINISHED', unfinishedFolderMessage(path, id, operation)) : null;
}

/** Every item folder of this repository left mid-merge, rebase or cherry-pick, with its seat and item, for the health report (#3763). */
export function unfinishedFolders(root, seats) {
  return unfinishedItemFolders([...worktreeBranches(root).commits.keys()], seats, tryGit);
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
  if (!board || !tree.path?.endsWith(suffix) || tree.locked) throw protectedFolderRefusal(ref, tree.path);
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
    const session = await import('../join.js');
    const prior = session.endedItemFolderSession(board, me, tree.path);
    // Adopt: a move keeps the branch's commits and the folder itself, so nothing the ended seat left is lost (#3540).
    git(ctx.info.root, ['worktree', 'move', tree.path, desired]);
    await session.adoptItemFolderSession(desired, me, prior);
    return true;
  }
  const unfinished = unfinishedFolderRefusal(tree.path, id);
  if (unfinished) throw unfinished;
  // A dirty folder is archived only once its holder's session has ended; a live session keeps it and is named (#3720).
  (await import('../join.js')).endedItemFolderSession(board, me, tree.path);
  if (!holder) throw new Refused('ITEM_FOLDER_UNREGISTERED', `item folder ${tree.path} has uncommitted changes and no registered prior holder; it is retained. The coordinator archives or removes the folder, or the seat continues in its own folder`);
  const status = tryGit(tree.path, ['status', '--porcelain', '--untracked-files=all', '--ignored=matching']);
  if (status.status !== 0) throw new Error(`cannot inspect prior item folder ${tree.path}; retained`);
  if (status.stdout) {
    if (typeof onArchive !== 'function') throw new Error('a dirty item folder needs a native recovery note before removal');
    const archive = archiveOrRefuse(tree.path, ctx.info.commonDir, { includeMetadata: true });
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
 * The ITEM_FOLDER_SESSION_LIVE or ITEM_FOLDER_UNFINISHED refusal claiming this item's folder would meet, or null, read without moving, binding or
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
  const prior = fs.exists(path) ? null : branchCheckoutFromFiles(ctx.info.commonDir, branch(me.lane, id));
  const folder = prior ? prior.path : path;
  if (!folder || !fs.exists(folder)) return null;
  // A locked or foreign folder is never adopted (recoverPriorFolder); next passes over its item instead of refusing the call.
  if (prior && (prior.locked || !folder.endsWith(`-item-${id}`))) return protectedFolderRefusal(branch(me.lane, id), folder);
  const session = await import('../join.js');
  try { session.endedItemFolderSession(board, me, folder); }
  catch (error) {
    if (error instanceof Refused && error.code === 'ITEM_FOLDER_SESSION_LIVE') return error;
    throw error;
  }
  // The prior folder next would recover, left mid-merge, is refused here and next selects another item (#3763).
  return folder === path ? null : unfinishedFolderRefusal(folder, id);
}

/** The ITEM_FOLDER_DIRTY refusal for this seat's own item folder holding uncommitted files on a fresh claim. */
function dirtyFolderRefusal(path, dirty) {
  return new Refused('ITEM_FOLDER_DIRTY', `item folder ${path} has dirty files ${dirty.join(', ')}; preserve or recover them before claiming again`);
}

/** The files `git status` names in a folder, or null when git cannot read it. */
function dirtyFiles(path) {
  const status = tryGit(path, ['status', '--porcelain', '--untracked-files=all']);
  return status.status === 0 ? status.stdout.split('\n').filter(Boolean).map(line => line.slice(3)) : null;
}

/**
 * The folder refusal an explicit claim would meet, read before the move and without changing anything (#5766): a folder
 * another live session holds, a protected or mid-merge prior folder, or this seat's own item folder dirty on a fresh claim.
 * Why: the folder was opened after the claim committed, so 233 claims in 4 days were recorded while the command refused.
 *
 * @param {any} ctx
 * @param {any} board
 * @param {{ id: string, lane: string }} me the seat about to claim
 * @param {number} id the item
 * @param {{ renewing?: boolean }} [options] a renewal keeps its own folder's uncommitted work
 * @returns {Promise<Refused|null>}
 */
export async function claimFolderRefusal(ctx, board, me, id, { renewing = false } = {}) {
  const live = await liveFolderRefusal(ctx, board, me, id);
  if (live || renewing || me.id === 'coordinator' || await hostedRunner()) return live;
  const path = itemFolderPath(seatRoot(ctx, board, me), id);
  if (!fs.exists(path) || checkoutBranch(path) !== branch(me.lane, id)) return null;
  const dirty = dirtyFiles(path);
  return dirty?.length ? dirtyFolderRefusal(path, dirty) : null;
}

/**
 * What claim says when the item folder refuses after the claim was recorded: the claim stands, so the command exits
 * claimed with the folder's problem and a next step for it, never as a refusal the board contradicts (#5766).
 *
 * @param {Refused} error the folder refusal
 * @param {number|string} id the item
 * @returns {{ code: string, message: string, next: string }}
 */
export function claimedFolderProblem(error, id) {
  const message = error.message.replace(/^\[[A-Z0-9_]+\]\s*/u, '');
  return { code: error.code, message, next: error.next ?? `fix the item folder (${error.code}), then pullboard claim ${id} to open it` };
}

/** Whether two paths name one existing directory, however each was spelled. */
function sameDirectory(first, second) {
  try { return first !== null && fs.realpath(first) === fs.realpath(second); } catch { return false; }
}

/**
 * Fast-forward a clean item folder with no commits of its own, or return a note about a divergent branch.
 * Finish and submit merge main, so claim can leave divergent folders untouched [C7,#12577].
 * @param {string} path the item folder
 * @param {string} trunk the repository's trunk branch
 * @returns {string|null} the note to report, if the branch has diverged
 */
function advanceToMain(path, trunk) {
  // A folder at the trunk tip needs no Git process on a warm claim (#8691).
  const head = checkoutHead(path);
  if (head !== undefined && head === checkoutRefCommit(path, `refs/heads/${trunk}`)) return null;
  const distance = tryGit(path, ['rev-list', '--left-right', '--count', `HEAD...${trunk}`]);
  if (distance.status !== 0) return null;
  const [ahead, behind] = distance.stdout.split(/\s+/u).map(Number);
  if (!behind) return null;
  if (ahead) return `item branch is ${behind} commit${behind === 1 ? '' : 's'} behind ${trunk}, and submit merges ${trunk}`;
  const status = tryGit(path, ['status', '--porcelain', '--untracked-files=all']);
  if (status.status === 0 && !status.stdout) {
    tryGit(path, [...parallelCheckout(path), 'merge', '--ff-only', '-q', trunk]);
  }
  return null;
}

/**
 * Whether a folder's Git link is gone: no `.git` entry, or a `.git` file naming a worktree directory that was removed.
 * @param {string} path the item folder
 * @returns {boolean}
 */
function worktreeGone(path) {
  const link = `${path}/.git`;
  if (!fs.exists(link)) return true;
  let text;
  try { text = fs.readFile(link, 'utf8'); } catch { return false; }
  const target = /^gitdir:\s*(.+)$/mu.exec(text)?.[1]?.trim();
  return Boolean(target) && !fs.exists(resolve(path, target));
}

/**
 * Move a folder whose worktree was removed out of the way and prune the dead registration, so claim makes a working one.
 * Why: next handed such a folder out as the item folder, and every Git command in it failed [C7,#4990].
 * The old files are kept beside it; the item branch keeps its commits, and the one-line note says whether any wait for submit.
 * @param {string} root the repository root
 * @param {string} path the item folder
 * @param {string} ref the item branch
 * @returns {void}
 */
function replaceGoneFolder(root, path, ref) {
  const kept = `${path}.gone-${Date.now()}`;
  fs.rename(path, kept);
  tryGit(root, ['worktree', 'prune']);
  const exists = tryGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`]).status === 0;
  const ahead = exists ? Number(tryGit(root, ['rev-list', '--count', `${trunkBranch(root)}..${ref}`]).stdout) || 0 : 0;
  process.stderr.write(`item folder ${path} had lost its Git worktree; its old files are kept at ${kept}. `
    + (ahead > 0 ? `${ref} holds ${ahead} earlier commit${ahead === 1 ? '' : 's'} not on ${trunkBranch(root)}: the new folder has them, so build on them and submit.\n`
      : `${ref} holds no earlier commits: nothing waits to be submitted.\n`));
}

/** Open or reuse the item's branch folder, fast-forwarding where possible. Runner-hosted folders stay on their runner [C7]. */
export async function openItemFolder(ctx, me, id, options = {}) {
  const path = await openFolder(ctx, me, id, options);
  if (typeof path === 'string' && fs.exists(path)) {
    const note = advanceToMain(path, trunkBranch(ctx.info.root));
    if (note) {
      if (options.onBehind) options.onBehind(note);
      else process.stderr.write(`${note}\n`);
    }
  }
  return path;
}

/**
 * Whether the repository has a primary checkout to build a new folder from, answered from Git's files for an ordinary clone and by Git only otherwise [C7,#10821].
 * Why: asking Git (a worktree list and a rev-parse) cost two launches on every claim that opens a new folder.
 * An ordinary clone's shared Git directory is the .git folder inside its primary checkout, which is what the files show.
 * @param {{ isMain?: boolean, root: string, commonDir: string }} info the checkout facts of the command
 * @returns {boolean}
 */
function hasPrimaryCheckout(info) {
  if (info.isMain) return true;
  try {
    const common = fs.realpath(info.commonDir);
    if (basename(common) === '.git' && fs.stat(common).isDirectory() && fs.realpath(join(dirname(common), '.git')) === common) return true;
  } catch { /* Files cannot answer; Git does. */ }
  return Boolean(primaryCheckoutRoot(info));
}

/**
 * Whether the item's branch exists, read from Git's ref files, or from Git when the files cannot answer [C7,#10821].
 * @param {string} root any checkout of the repository
 * @param {string} ref the item branch
 * @returns {boolean}
 */
function branchExists(root, ref) {
  const commit = checkoutRefCommit(root, `refs/heads/${ref}`);
  return commit === undefined ? tryGit(root, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`]).status === 0 : commit !== null;
}

/** The runner hosting this seat's item folders, or null; the runner command and its cells load only when the seat names one, so a plain command never pays for them [C7]. */
async function hostedRunner() {
  return environmentAdapter().get('PULLBOARD_ITEM_FOLDER_RUNNER')?.trim() ? (await import('../commands/runner.js')).itemFolderRunner() : null;
}

/**
 * Open or reuse this item's branch folder without advancing it.
 *
 * @param {any} ctx
 * @param {{ id: string, lane: string }} me the claiming seat
 * @param {number} id the item
 * @param {any} options
 * @returns {Promise<string|object|null>} the folder path, a runner-hosted folder record, or null for the coordinator and a URL-joined seat
 */
async function openFolder(ctx, me, id, options = {}) {
  if (me.id === 'coordinator') return null;
  // A seat joined by board URL builds in its own clone; a folder here on the board host would hold nothing it can submit [C7].
  if (ctx.io?.remoteAgent) return null;
  const runner = await hostedRunner();
  if (runner) {
    const hooks = tryGit(ctx.info.root, ['config', '--get', 'core.hooksPath']);
    return (await import('../commands/runner.js')).openHostedItemFolder(runner, { itemId: id, branch: branch(me.lane, id), commonDir: ctx.info.commonDir,
      hooksPath: hooks.status === 0 ? hooks.stdout : undefined });
  }
  const root = ctx.info.root, path = itemFolderPath(seatRoot(ctx, options.board, me), id), ref = branch(me.lane, id);
  if (fs.exists(path) && worktreeGone(path)) replaceGoneFolder(root, path, ref);
  if (fs.exists(path)) {
    if (checkoutBranch(path) !== ref || !sameDirectory(checkoutCommonDir(path), ctx.info.commonDir)) throw new Error(`item folder ${path} is occupied by another checkout`);
    if (!options.renewed) {
      const dirty = dirtyFiles(path);
      if (!dirty) throw new Error(`cannot inspect item folder ${path}; preserve it and retry`);
      if (dirty.length) throw dirtyFolderRefusal(path, dirty);
    }
    // The folder may still be bound to an ended session of this seat path: the claimer takes it over (#3679).
    const session = await import('../join.js');
    await session.adoptItemFolderSession(path, me, session.endedItemFolderSession(options.board, me, path));
    writeItemMarker(path, me.id, id);
    return path;
  }
  if (!hasPrimaryCheckout(ctx.info)) throw new Error('cannot locate the primary checkout for the item folder');
  const exists = branchExists(root, ref);
  if (exists && await recoverPriorFolder(ctx, me, id, path, ref, options)) {
    writeItemMarker(path, me.id, id);
    return path;
  }
  if (await reuseIdleFolder(ctx, me, id, path, ref, exists, options)) {
    writeItemMarker(path, me.id, id);
    return path;
  }
  // A prepared spare is moved into place and switched to the branch; only without one is every file written (#5776).
  const seat = seatRoot(ctx, options.board, me), workers = parallelCheckout(root), trunk = trunkBranch(root);
  if (!takeSpareFolder(root, seat, path, [...workers, ...(exists ? ['checkout', '-q', ref] : ['checkout', '-q', '-b', ref, trunk])])) {
    git(root, [...workers, ...(exists ? ['worktree', 'add', path, ref] : ['worktree', 'add', '-b', ref, path, trunk])]);
  }
  writeItemMarker(path, me.id, id);
  await prepareSpareFolder(root, seat, trunk, workers);
  return path;
}
