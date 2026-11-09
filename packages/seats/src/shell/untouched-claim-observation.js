import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { checkoutHead } from '../../../git/index.js';
import { gitExecFileSync } from '../../../git/index.js';
import { statusPaths } from '../../../git/index.js';
import { worktreeStatus } from '../../../git/index.js';

/**
 * Freeze a Git worktree's content; failure is unknown, never evidence of no work. The status is the command's shared
 * one, and its untracked entries are the same set ls-files --others --exclude-standard lists, so the digest is unchanged.
 */
export function claimWorktreeSnapshot(root) {
  try {
    const git = args => gitExecFileSync(args, { cwd: root, timeout: 5000 });
    const head = checkoutHead(root) ?? git(['rev-parse', '--verify', 'HEAD']).toString().trim();
    if (!/^[0-9a-f]{40,64}$/u.test(head)) return null;
    const hash = createHash('sha256');
    const add = data => { const value = Buffer.from(data); hash.update(`${value.length}:`); hash.update(value); };
    const status = worktreeStatus(root);
    add(status);
    const { changed, untracked: listed } = statusPaths(status);
    // With no tracked change both diffs are empty, the same bytes Git would print, so they need no Git process.
    add(changed.length ? git(['diff', '--binary', '--no-ext-diff']) : '');
    add(changed.length ? git(['diff', '--cached', '--binary', '--no-ext-diff']) : '');
    const untracked = listed.sort();
    for (const file of untracked) {
      const path = join(root, file);
      const stat = lstatSync(path);
      add(file);
      add(String(stat.mode));
      add(stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path));
    }
    return { head, digest: hash.digest('hex') };
  } catch { return null; }
}
