import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { gitExecFileSync } from '../packages/git/index.js';

/** Freeze a Git worktree's content; failure is unknown, never evidence of no work. */
export function claimWorktreeSnapshot(root) {
  try {
    const git = args => gitExecFileSync(args, { cwd: root, timeout: 5000 });
    const head = git(['rev-parse', '--verify', 'HEAD']).toString().trim();
    if (!/^[0-9a-f]{40,64}$/u.test(head)) return null;
    const hash = createHash('sha256');
    const add = data => { const value = Buffer.from(data); hash.update(`${value.length}:`); hash.update(value); };
    add(git(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
    add(git(['diff', '--binary', '--no-ext-diff']));
    add(git(['diff', '--cached', '--binary', '--no-ext-diff']));
    const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).toString().split('\0').filter(Boolean).sort();
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
