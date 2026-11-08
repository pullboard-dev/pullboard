/** Filesystem evidence keeps editing seats alive without spawning Git on ordinary writes [B4,C7]. */
import { existsSync } from 'node:fs';
import { lstatSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { resolve } from 'node:path';

/**
 * Read the native item folder (or the original seat checkout) for changes within fifteen minutes.
 * Unknown or oversized observations cannot prove a seat gone. HEAD's reflog also captures commits,
 * including empty commits whose worktree files do not change.
 */
export function claimFolderActive(root, id, now) {
  const folder = claimFolder(root, id);
  if (!existsSync(folder)) return false;
  const cutoff = now - 15 * 60_000;
  /** Only an actual filesystem timestamp in the observation's past proves recent activity. */
  const recent = stat => Number.isFinite(stat.mtimeMs) && stat.mtimeMs >= cutoff && stat.mtimeMs <= now;
  try {
    const log = headLog(folder);
    if (log === null) return null;
    if (existsSync(log) && recent(lstatSync(log))) return true;
    const pending = [folder];
    let count = 0;
    while (pending.length) {
      for (const entry of readdirSync(pending.pop(), { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        if (++count > 10_000) return null;
        const path = join(entry.parentPath, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (recent(lstatSync(path))) return true;
      }
    }
    return false;
  } catch { return null; }
}

/** The claim's native item folder beside the seat checkout, or the seat checkout itself when there is none. */
function claimFolder(root, id) {
  const itemRoot = join(dirname(root), `${basename(root)}-item-${id}`);
  return existsSync(itemRoot) ? itemRoot : root;
}

/** The HEAD reflog path of a checkout or linked worktree, read without Git; null when .git is unreadable. Throws when .git is missing. */
function headLog(folder) {
  const dotGit = join(folder, '.git');
  const metadata = lstatSync(dotGit);
  if (metadata.isDirectory()) return join(dotGit, 'logs', 'HEAD');
  if (!metadata.isFile()) return null;
  const pointer = /^gitdir: (.+)\s*$/u.exec(readFileSync(dotGit, 'utf8'));
  return pointer ? join(resolve(folder, pointer[1].trim()), 'logs', 'HEAD') : null;
}

/**
 * When HEAD last moved in the claim's item folder (or the seat checkout), as a canonical instant, or null when unknown
 * or in the future. A commit always moves HEAD's reflog, so this reads commits without spawning Git (#3446).
 */
export function claimFolderCommitAt(root, id, now) {
  try {
    const log = headLog(claimFolder(root, id));
    if (log === null || !existsSync(log)) return null;
    const at = Math.floor(lstatSync(log).mtimeMs);
    return Number.isFinite(at) && at <= now ? new Date(at).toISOString() : null;
  } catch { return null; }
}
