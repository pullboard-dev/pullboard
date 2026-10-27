/** A retry checks an immutable merge object without changing the reviewer's checkout or the submitted item [V4,V8]. */
import {
  cleanGitEnvironment,
  git,
  tryGit,
} from './git.js';
import { Refused } from './refused.js';

/**
 * Create the exact clean composition for the one mid-check retry. Git object writes cannot execute candidate hooks.
 * Ordinary merge conflicts stay refusals; no generated or guessed conflict resolution enters a review.
 *
 * @param {string} root
 * @param {string} checkedCommit
 * @param {{ ref: string, commit: string }} trunk
 * @returns {string}
 */
export function retryReviewCommit(root, checkedCommit, trunk) {
  const merge = tryGit(root, ['merge-tree', '--write-tree', '--name-only', '-z', trunk.commit, checkedCommit], { env: cleanGitEnvironment() });
  if (merge.status !== 0) throw new Refused('MERGE_CONFLICT', 'the review retry cannot form a clean merge with current main; merge main into the item, resolve the conflicts, commit and resubmit');
  const tree = merge.stdout.split('\0')[0].trim();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(tree)) throw new Refused('MERGE_CHECK_FAILED', 'Git did not return a readable retry merge tree; restore its objects and retry verification');
  const env = { ...cleanGitEnvironment(), GIT_AUTHOR_NAME: 'Pullboard review', GIT_AUTHOR_EMAIL: 'review@pullboard.invalid',
    GIT_COMMITTER_NAME: 'Pullboard review', GIT_COMMITTER_EMAIL: 'review@pullboard.invalid' };
  return git(root, ['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', trunk.commit, '-p', checkedCommit,
    '-m', 'chore(review): compose the bounded verification retry [V4,V8]'], { env });
}
