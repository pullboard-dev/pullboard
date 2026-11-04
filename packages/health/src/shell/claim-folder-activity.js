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
  const itemRoot = join(dirname(root), `${basename(root)}-item-${id}`);
  const folder = existsSync(itemRoot) ? itemRoot : root;
  if (!existsSync(folder)) return false;
  const cutoff = now - 15 * 60_000;
  /** Only an actual filesystem timestamp in the observation's past proves recent activity. */
  const recent = stat => Number.isFinite(stat.mtimeMs) && stat.mtimeMs >= cutoff && stat.mtimeMs <= now;
  try {
    const dotGit = join(folder, '.git');
    const metadata = lstatSync(dotGit);
    let gitDir = dotGit;
    if (metadata.isFile()) {
      const pointer = /^gitdir: (.+)\s*$/u.exec(readFileSync(dotGit, 'utf8'));
      if (!pointer) return null;
      gitDir = resolve(folder, pointer[1].trim());
    } else if (!metadata.isDirectory()) return null;
    const log = join(gitDir, 'logs', 'HEAD');
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
