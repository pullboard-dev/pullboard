import { join } from 'node:path';
import { resolve } from 'node:path';
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';

/**
 * Find the shared git directory by reading `.git` (and `commondir` for a linked worktree) instead of starting git.
 * Why: every read command asked git for this just to learn the link path, about 200 ms each [C7].
 * Anything unusual returns null so the caller asks git.
 */
export function readCommonDir(root) {
  try {
    const dotGit = join(root, '.git');
    const stat = lstatSync(dotGit);
    if (stat.isDirectory()) return realpathSync(dotGit);
    const match = /^gitdir:\s*(.+)\s*$/mu.exec(readFileSync(dotGit, 'utf8'));
    if (match) {
      const gitDir = resolve(root, match[1]);
      const common = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
      return realpathSync(resolve(gitDir, common));
    }
  } catch { /* Not a plain checkout root: ask git. */ }
  return null;
}
