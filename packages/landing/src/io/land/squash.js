/** squashOnto: land an item tip as one single-parent commit on a base, keeping the branch reachable under refs/pullboard/items/<id> [C7,#9218]. */
import { tryGit } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';

/** The ref that keeps an item's branch commits reachable after a squash. */
export function itemKeepRef(item) {
  return `refs/pullboard/items/${item}`;
}

/**
 * Squash `tip` onto `base`: the commit has `base` as its only parent, the tree `git merge-tree --write-tree` gives for both, and `message`.
 * Why the keep ref: the squash drops the branch's commits from main's history, so the ref holds them for audit.
 * A conflicting tip returns { conflict, files } and writes nothing, so the caller decides what to do.
 *
 * @param {string} root
 * @param {{ base: string, tip: string, message: string, item: number }} landing
 * @returns {{ commit: string } | { conflict: true, files: string[] }}
 */
export function squashOnto(root, { base, tip, message, item }) {
  if (!Number.isSafeInteger(item) || item < 1) {
    throw new Refused('SQUASH_ITEM', 'a squash names its item as a whole number', 'pass the item id being landed');
  }
  const merged = tryGit(root, ['merge-tree', '--write-tree', '--name-only', base, tip]);
  if (merged.status === 1) {
    const files = merged.stdout.split('\n\n')[0].split('\n').slice(1).filter(Boolean);
    return { conflict: true, files };
  }
  if (merged.status !== 0) throw new Refused('SQUASH_MERGE', `could not merge #${item} onto ${base.slice(0, 12)}: ${merged.stderr.split('\n')[0]}`, 'check both commits exist in this repository');
  const tree = merged.stdout.split('\n')[0];
  // Why a fallback identity: the lander may run where git has none configured, and commit-tree refuses without one.
  const known = tryGit(root, ['config', 'user.email']).stdout !== '';
  const fallback = { GIT_AUTHOR_NAME: 'pullboard', GIT_AUTHOR_EMAIL: 'lander@pullboard.invalid', GIT_COMMITTER_NAME: 'pullboard', GIT_COMMITTER_EMAIL: 'lander@pullboard.invalid' };
  const commit = tryGit(root, ['commit-tree', tree, '-p', base, '-m', message], known ? {} : { env: { ...process.env, ...fallback } });
  if (commit.status !== 0) throw new Refused('SQUASH_COMMIT', `could not write the squash commit for #${item}: ${commit.stderr.split('\n')[0]}`, 'check the repository can be written and git has an identity');
  const kept = tryGit(root, ['update-ref', itemKeepRef(item), tip]);
  if (kept.status !== 0) throw new Refused('SQUASH_KEEP', `could not keep ${itemKeepRef(item)} for #${item}: ${kept.stderr.split('\n')[0]}`, 'check the repository can be written');
  return { commit: commit.stdout };
}
