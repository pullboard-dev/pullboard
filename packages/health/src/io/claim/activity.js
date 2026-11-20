/** Filesystem evidence keeps editing seats alive without spawning Git on ordinary writes [B4,C7]. */
import { fileSystemAdapter } from '../../../../fs/index.js';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';

const fs = fileSystemAdapter();

/**
 * Read the native item folder (or the original seat checkout) for changes within fifteen minutes.
 * Unknown or oversized observations cannot prove a seat gone. HEAD's reflog also captures commits,
 * including empty commits whose worktree files do not change.
 */
export function claimFolderActive(root, id, now) {
  const folder = claimFolder(root, id);
  if (!fs.exists(folder)) return false;
  const cutoff = now - 15 * 60_000;
  /** Only an actual filesystem timestamp in the observation's past proves recent activity. */
  const recent = stat => Number.isFinite(stat.mtimeMs) && stat.mtimeMs >= cutoff && stat.mtimeMs <= now;
  try {
    const log = headLog(folder);
    if (log === null) return null;
    if (fs.exists(log) && recent(fs.lstat(log))) return true;
    const pending = [folder];
    let count = 0;
    while (pending.length) {
      for (const entry of fs.list(pending.pop(), { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        if (++count > 10_000) return null;
        const path = join(entry.parentPath, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (recent(fs.lstat(path))) return true;
      }
    }
    return false;
  } catch { return null; }
}

/**
 * The Git folder that holds a checkout's repository: its own .git, or the common folder a linked worktree points at.
 * Read from the files alone, so no Git process runs; null when it cannot be read.
 */
function commonGitDir(folder) {
  try {
    const dotGit = join(folder, '.git');
    const metadata = fs.lstat(dotGit);
    if (metadata.isDirectory()) return resolve(dotGit);
    const pointer = /^gitdir: (.+)\s*$/u.exec(fs.readFile(dotGit, 'utf8'));
    if (!metadata.isFile() || !pointer) return null;
    const gitDir = resolve(folder, pointer[1].trim());
    const common = join(gitDir, 'commondir');
    return fs.exists(common) ? resolve(gitDir, fs.readFile(common, 'utf8').trim()) : gitDir;
  } catch { return null; }
}

/**
 * An item folder an earlier seat opened and this claim's seat adopted: a sibling named `<anything>-item-<id>` that is a
 * worktree of the same repository as the seat checkout. The newest by name wins when several remain.
 */
function adoptedItemFolder(root, id) {
  const suffix = `-item-${id}`;
  try {
    const repository = commonGitDir(root);
    if (!repository) return null;
    const parent = dirname(root);
    const found = fs.list(parent).filter(name => name.endsWith(suffix)).sort().reverse()
      .map(name => join(parent, name)).filter(folder => commonGitDir(folder) === repository);
    return found[0] ?? null;
  } catch { return null; }
}

/**
 * The claim's native item folder beside the seat checkout; else the folder an earlier seat opened that this claim
 * adopted (the claim moves seats, the work stays in the first seat's folder); else the seat checkout itself.
 */
function claimFolder(root, id) {
  const itemRoot = join(dirname(root), `${basename(root)}-item-${id}`);
  return fs.exists(itemRoot) ? itemRoot : adoptedItemFolder(root, id) ?? root;
}

/** The HEAD reflog path of a checkout or linked worktree, read without Git; null when .git is unreadable. Throws when .git is missing. */
function headLog(folder) {
  const dotGit = join(folder, '.git');
  const metadata = fs.lstat(dotGit);
  if (metadata.isDirectory()) return join(dotGit, 'logs', 'HEAD');
  if (!metadata.isFile()) return null;
  const pointer = /^gitdir: (.+)\s*$/u.exec(fs.readFile(dotGit, 'utf8'));
  return pointer ? join(resolve(folder, pointer[1].trim()), 'logs', 'HEAD') : null;
}

/**
 * When HEAD last moved in the claim's item folder (or the seat checkout), as a canonical instant, or null when unknown
 * or in the future. A commit always moves HEAD's reflog, so this reads commits without spawning Git (#3446).
 */
export function claimFolderCommitAt(root, id, now) {
  try {
    const log = headLog(claimFolder(root, id));
    if (log === null || !fs.exists(log)) return null;
    const at = Math.floor(fs.lstat(log).mtimeMs);
    return Number.isFinite(at) && at <= now ? new Date(at).toISOString() : null;
  } catch { return null; }
}
