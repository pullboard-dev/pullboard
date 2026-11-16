/** The lander's pull-out revert: undo one landed commit on the trunk tip without a worktree or a checkout move [M2,R3]. */
import { tryGit } from '../../../../git/index.js';
import { Refused } from '../../../../kernel/index.js';

const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

/** Resolve one revision to its full commit id, or null when it names no commit. */
function commitOf(checkout, revision) {
  const found = tryGit(checkout, ['rev-parse', '--verify', '-q', `${revision}^{commit}`]);
  return found.status === 0 && OID.test(found.stdout) ? found.stdout : null;
}

/**
 * Git's tree for `theirs` merged onto `ours` from `base`, or its conflicted paths.
 * Why `--merge-base`: a revert is the three-way merge whose base is the reverted commit and whose other side is its parent.
 *
 * @returns {{ tree: string } | { conflicts: string[] }}
 */
function revertTree(checkout, { base, ours, theirs }) {
  const merged = tryGit(checkout, ['-c', 'core.quotepath=false', 'merge-tree', '--write-tree', '--name-only', '-z', `--merge-base=${base}`, ours, theirs]);
  const output = merged.stdout.split('\0');
  const tree = output[0].trim();
  if (![0, 1].includes(merged.status) || !OID.test(tree)) {
    throw new Refused('PULL_OUT_REVERT', `git could not compute the revert of ${base} on ${ours}: ${merged.stderr || merged.stdout || `exit ${merged.status}`}; check the checkout's git and retry the pull-out`);
  }
  if (merged.status === 0) return { tree };
  const records = output.slice(1);
  const end = records.indexOf('');
  const conflicts = [...new Set(records.slice(0, end < 0 ? records.length : end))].sort();
  return { conflicts };
}

/**
 * Revert a landed commit on the trunk tip: `git revert -m 1` for a landing merge, a plain revert for a non-merge commit.
 * Returns `{ commit, trunk }`, the new revert commit whose one parent is the trunk tip, or `{ conflicts, trunk }` naming the
 * conflicted paths when the revert does not apply cleanly; nothing is committed then.
 * Why plumbing (merge-tree plus commit-tree) and not `git revert` in a checkout: the checkout's HEAD, index and files are
 * never touched, so a conflict leaves no revert in progress to abort and the checkout stays at the trunk tip; the static
 * check allows no second `git worktree add`. Moving trunk is the caller's: it pushes the returned commit through the fence.
 *
 * @param {string} checkout - any checkout of the repository
 * @param {string} mergedCommit - the item's recorded landed commit
 * @param {string} trunk - the trunk tip to revert on: a ref or a commit
 * @param {{ message?: string }} [options] - the revert's commit message; Git's own revert message by default
 * @returns {{ commit: string, trunk: string } | { conflicts: string[], trunk: string }}
 */
export function revertLanded(checkout, mergedCommit, trunk, { message } = {}) {
  const merged = commitOf(checkout, mergedCommit);
  if (!merged) throw new Refused('PULL_OUT_REVERT', `the landed commit ${mergedCommit} is not in this repository; fetch the trunk, then retry the pull-out`);
  const tip = commitOf(checkout, trunk);
  if (!tip) throw new Refused('PULL_OUT_REVERT', `the trunk ${trunk} names no commit; fetch the trunk, then retry the pull-out`);
  const parents = tryGit(checkout, ['rev-list', '--parents', '-n', '1', merged]).stdout.split(' ').slice(1);
  // -m 1: a landing merge is undone against its first parent, the trunk it landed on.
  const parent = parents[0];
  if (!parent) throw new Refused('PULL_OUT_REVERT', `the landed commit ${merged} has no parent to revert to; pull it out by hand`);
  const result = revertTree(checkout, { base: merged, ours: tip, theirs: parent });
  if (result.conflicts) return { conflicts: result.conflicts, trunk: tip };
  const subject = tryGit(checkout, ['log', '-1', '--format=%s', merged]).stdout;
  const body = parents.length > 1
    ? `This reverts commit ${merged}, reversing\nchanges made to ${parent}.`
    : `This reverts commit ${merged}.`;
  const text = message ?? `Revert "${subject}"\n\n${body}`;
  const written = tryGit(checkout, ['commit-tree', result.tree, '-p', tip, '-m', text]);
  if (written.status !== 0 || !OID.test(written.stdout)) {
    throw new Refused('PULL_OUT_REVERT', `git could not write the revert commit: ${written.stderr || written.stdout}; set a committer identity in the checkout, then retry the pull-out`);
  }
  return { commit: written.stdout, trunk: tip };
}
