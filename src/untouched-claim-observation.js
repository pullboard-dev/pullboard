import { tryGit } from '../packages/git/index.js';

/** Freeze only positive, clean worktree evidence; Git failure is never treated as clean. */
export function cleanClaimHead(root) {
  const head = tryGit(root, ['rev-parse', '--verify', 'HEAD']);
  const status = tryGit(root, ['status', '--porcelain', '--untracked-files=all']);
  return head.status === 0 && /^[0-9a-f]{40,64}$/u.test(head.stdout) && status.status === 0 && !status.stdout ? head.stdout : null;
}
