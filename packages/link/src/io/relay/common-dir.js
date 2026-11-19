import { join } from 'node:path';
import { resolve } from 'node:path';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();

/**
 * Find the shared git directory by reading `.git` (and `commondir` for a linked worktree) instead of starting git.
 * Why: every read command asked git for this just to learn the link path, about 200 ms each [C7].
 * Anything unusual returns null so the caller asks git.
 */
export function readCommonDir(root) {
  try {
    const dotGit = join(root, '.git');
    const stat = fs.lstat(dotGit);
    if (stat.isDirectory()) return fs.realpath(dotGit);
    const match = /^gitdir:\s*(.+)\s*$/mu.exec(fs.readFile(dotGit, 'utf8'));
    if (match) {
      const gitDir = resolve(root, match[1]);
      const common = fs.readFile(join(gitDir, 'commondir'), 'utf8').trim();
      return fs.realpath(resolve(gitDir, common));
    }
  } catch { /* Not a plain checkout root: ask git. */ }
  return null;
}
