/** One memoized answer for the HEAD commit and tree a submit reads many times [C7,#6500]. */
import { checkoutHead } from '../../../../git/index.js';
import { git } from '../../../../git/index.js';

/** A commit's tree never changes, so each is asked of Git once per process. */
const trees = new Map();

/**
 * The checkout's HEAD commit and its tree.
 * Why: the retry, the auto path and the head read each spawned `git rev-parse HEAD`; the commit is read from the checkout's
 * files (a spawn only when they cannot answer) and the tree is remembered by commit, which is immutable, so a moved HEAD is never stale.
 *
 * @param {string} root a checkout of the repository
 * @returns {{ commit: string, tree: string }}
 */
export function headRevs(root) {
  const commit = checkoutHead(root) ?? git(root, ['rev-parse', 'HEAD']);
  if (!trees.has(commit)) trees.set(commit, git(root, ['rev-parse', `${commit}^{tree}`]));
  return { commit, tree: trees.get(commit) };
}

/** The checkout's HEAD commit through the same memoized call. */
export function headCommitOf(root) { return headRevs(root).commit; }
