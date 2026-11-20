/** Lease independent Git worktrees by moving them, and restore trusted metadata before recycling [C7,P3]. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileSystemAdapter } from '../../../fs/index.js';

const fs = fileSystemAdapter();

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const SLOT = /^[a-f0-9-]{36}$/u;
const LIMIT = 4;

/** Every pool operation must run under the existing repository-cache admission. */
function admitted(lease) {
  if (typeof lease?.release !== 'function') throw new Error('warm checkout requires its repository-cache lease');
}

/** Reject links and non-directory entries before following a runner-private path. */
function directoryAt(path) {
  const stat = fs.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('warm checkout is not a private directory');
}

/** Read bounded source identities; these describe bytes, never a prior gate's verdict. */
function metadata(slot) {
  directoryAt(slot);
  const file = join(slot, 'source.json'), stat = fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('warm checkout metadata is invalid');
  const value = JSON.parse(fs.readFile(file, 'utf8'));
  if (value.version !== 1 || !SHA.test(value.commit) || !SHA.test(value.tree)
    || value.commit.length !== value.tree.length || !Number.isSafeInteger(value.usedAt)) throw new Error('warm checkout metadata is invalid');
  return value;
}

/** Publish one complete private source identity while the cache lease excludes other borrowers. */
function publish(slot, commit, tree) {
  const temporary = join(slot, 'source.pending');
  fs.writeFile(temporary, JSON.stringify({ version: 1, commit, tree, usedAt: Date.now() }) + '\n', { mode: 0o600, flag: 'wx' });
  fs.rename(temporary, join(slot, 'source.json'));
}

/** Copy Git metadata only; worktree files never alias a command's writable files or require recursive copying. */
function snapshotGit(root, slot) {
  directoryAt(join(root, '.git'));
  if (fs.exists(join(root, '.git', 'objects', 'info', 'alternates'))) throw new Error('warm checkout must have independent objects');
  const temporary = join(slot, `base-${randomUUID()}.git`), backup = join(slot, 'base.git');
  try {
    fs.cp(join(root, '.git'), temporary, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true });
    fs.rm(backup, { recursive: true, force: true });
    fs.rename(temporary, backup);
  } finally { fs.rm(temporary, { recursive: true, force: true }); }
}

/** Upgrade the old private clean base without copying its worktree or inheriting a command's mutations. */
async function adoptLegacy(directory, legacy, reachable) {
  if (!legacy || !fs.exists(legacy)) return;
  directoryAt(legacy);
  const file = join(legacy, '.git', 'pullboard-source-snapshot.json');
  const stat = fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error('source tree metadata is invalid');
  const value = JSON.parse(fs.readFile(file, 'utf8'));
  if (value.version !== 1 || !SHA.test(value.commit) || !SHA.test(value.tree)) throw new Error('source tree metadata is invalid');
  if (!(await reachable([{ commit: value.commit }])).length) return;
  const slot = join(directory, randomUUID());
  fs.mkdir(slot, { mode: 0o700 });
  try {
    snapshotGit(legacy, slot);
    publish(slot, value.commit, value.tree);
    fs.rename(legacy, join(slot, 'checkout'));
  } catch (error) { fs.rm(slot, { recursive: true, force: true }); throw error; }
}

/** Borrow only an idle ancestor; moving an independent tree leaves no shared writable alias behind. */
export async function borrowWarmCheckout({ directory, legacy, root, commit, history, ancestry, lease, git, env }) {
  admitted(lease);
  fs.mkdir(directory, { recursive: true, mode: 0o700 });
  directoryAt(directory);
  /** Enumerate only owned idle entries; borrowed slots have no checkout and cannot be pruned or borrowed twice. */
  const idle = () => fs.list(directory).filter(name => SLOT.test(name)).map(name => join(directory, name))
    .filter(slot => { directoryAt(slot); return fs.exists(join(slot, 'checkout')); })
    .map(slot => ({ slot, ...metadata(slot) }));
  /** With an ancestry oracle, ask it only about the commits in question instead of holding the whole history. */
  const reachable = async rows => {
    const known = ancestry ? await ancestry(rows.map(row => row.commit)) : history;
    return rows.filter(row => known.has(row.commit));
  };
  let available = await reachable(idle());
  if (!available.length) { await adoptLegacy(directory, legacy, reachable); available = await reachable(idle()); }
  available.sort((a, b) => Number(b.commit === commit) - Number(a.commit === commit) || b.usedAt - a.usedAt);
  if (!available.length) return null;
  const selected = available[0], checkout = join(selected.slot, 'checkout');
  directoryAt(checkout); directoryAt(join(checkout, '.git')); directoryAt(join(selected.slot, 'base.git'));
  if (fs.exists(join(checkout, '.git', 'objects', 'info', 'alternates'))) throw new Error('warm checkout does not match its clean committed base');
  // Both reads only inspect the idle checkout, so one process start covers them.
  const [identity, status] = await Promise.allSettled([git(checkout, ['rev-parse', 'HEAD', 'HEAD^{tree}'], env),
    git(checkout, ['status', '--porcelain=v1', '--untracked-files=all'], env)]);
  for (const read of [identity, status]) if (read.status === 'rejected') throw read.reason;
  if (identity.value !== `${selected.commit}\n${selected.tree}` || status.value) throw new Error('warm checkout does not match its clean committed base');
  directoryAt(root);
  fs.rmdir(root); // The caller allocated an empty job root; never remove an existing user's tree.
  try { fs.rename(checkout, root); }
  catch (error) { fs.mkdir(root, { mode: 0o700 }); throw error; }
  return { directory, slot: selected.slot, root, commit: selected.commit, tree: selected.tree, reusedCommit: selected.commit };
}

/** Save the pre-policy, pre-tag Git metadata outside the job before allowing command execution. */
export function snapshotWarmCheckout({ directory, root, commit, tree, lease, borrowed }) {
  admitted(lease);
  if (!SHA.test(commit) || !SHA.test(tree) || commit.length !== tree.length) throw new Error('warm checkout identity is invalid');
  const handle = borrowed ?? { directory, slot: join(directory, randomUUID()), root, reusedCommit: null };
  if (!borrowed) fs.mkdir(handle.slot, { mode: 0o700 });
  if (!borrowed || borrowed.commit !== commit || borrowed.tree !== tree) snapshotGit(root, handle.slot);
  publish(handle.slot, commit, tree);
  return { ...handle, commit, tree };
}

/** Drop only an owned unavailable cache slot; the ordinary job cleanup still owns its worktree. */
export function discardWarmCheckout(handle) {
  if (handle && SLOT.test(handle.slot.slice(handle.directory.length + 1))
    && !fs.exists(join(handle.slot, 'checkout'))) fs.rm(handle.slot, { recursive: true, force: true });
}

/** After every descendant drains, discard job Git state and mutations before returning an exact clean tree. */
export async function recycleWarmCheckout(handle, { lease, git, env }) {
  admitted(lease);
  if (!handle) return;
  const { root, slot, directory, commit, tree } = handle;
  directoryAt(root); directoryAt(slot); directoryAt(join(slot, 'base.git'));
  const value = metadata(slot);
  if (value.commit !== commit || value.tree !== tree) throw new Error('warm checkout source identity changed');
  fs.rm(join(root, '.git'), { recursive: true, force: true });
  fs.cp(join(slot, 'base.git'), join(root, '.git'), { recursive: true, mode: fs.constants.COPYFILE_FICLONE, verbatimSymlinks: true });
  await git(root, ['-c', 'core.hooksPath=/dev/null', 'reset', '--hard', commit], env);
  await git(root, ['-c', 'core.hooksPath=/dev/null', 'clean', '-ffdx'], env);
  if (await git(root, ['rev-parse', 'HEAD', 'HEAD^{tree}'], env) !== `${commit}\n${tree}`
    || await git(root, ['-c', 'core.ignoreStat=false', '-c', 'core.trustctime=true', 'status', '--porcelain=v1', '--untracked-files=all'], env)) {
    throw new Error('warm checkout could not restore its exact source tree');
  }
  publish(slot, commit, tree);
  fs.rename(root, join(slot, 'checkout'));
  const idle = fs.list(directory).filter(name => SLOT.test(name)).map(name => join(directory, name))
    .filter(path => fs.exists(join(path, 'checkout'))).map(path => ({ path, ...metadata(path) }))
    .sort((a, b) => b.usedAt - a.usedAt);
  for (const old of idle.slice(LIMIT)) fs.rm(old.path, { recursive: true, force: true });
}
