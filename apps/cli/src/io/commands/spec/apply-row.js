/** spec apply --row <id> [--commit]: narrow an apply to one row's pending decision, and commit it when asked [C7]. */
import { Refused } from '../../../../../../packages/kernel/index.js';
import { commitOnApplyEnabled } from '../../../../../../packages/config/index.js';
import { tryGit } from '../../../../../../packages/git/index.js';

/**
 * The decisions an apply may act on: all of them, or only the pending ones for one row.
 * An id with no pending decision is refused, never a silent no-op, so a typo cannot look like success.
 *
 * @param {object[]} decisions the board's row decisions
 * @param {string | undefined} rowId the --row value, if given
 * @returns {object[]}
 */
export function rowDecisionsFor(decisions, rowId) {
  if (rowId === undefined) return decisions;
  if (typeof rowId !== 'string' || !rowId.trim()) throw new Refused('USAGE', '--row needs a row id', 'pullboard spec apply --row <id>');
  const mine = decisions.filter(record => record.id === rowId && !record.applied);
  if (!mine.length) throw new Refused('USAGE', `${rowId} has no pending decision to apply`, 'pullboard spec');
  return decisions.filter(record => record.applied || record.id === rowId);
}

/** Git run in the checkout through the shared runner; a failing command throws its first message line. */
function checkoutGit(root) {
  return args => {
    const result = tryGit(root, args);
    if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args[0]} exited ${result.status}`);
    return result.stdout;
  };
}

/**
 * Refuse spec apply --row <id> --commit before any file is written when the checkout has uncommitted changes.
 * Why: the apply writes the row file first, so the dirty check must run ahead of it or the commit would sweep unrelated work in [C7,#9624].
 *
 * @param {string} root the checkout
 * @param {{ commit?: boolean, row?: string }} values the parsed flags
 */
export function requireCleanForCommit(root, { commit, row }) {
  if (!commit) return;
  if (typeof row !== 'string' || !row.trim()) throw new Refused('USAGE', '--commit applies one row, so it needs --row', 'pullboard spec apply --row <id> --commit');
  if (!commitOnApplyEnabled()) return;
  if (tryGit(root, ['status', '--porcelain']).stdout !== '') {
    throw new Refused('APPLY_NOT_COMMITTED', `the checkout has uncommitted changes, so ${row} was not committed`, 'commit or stash the changes, then run pullboard spec apply --row ' + row + ' --commit');
  }
}

/**
 * After the ordered apply, commit the applied row under the checkout's git identity when --commit was given and spec.commitOnApply is on.
 * Why: the decision is already marked applied by then, so a commit that fails leaves nothing pending; the checkout was proved clean before the write.
 *
 * @param {string} root the checkout
 * @param {{ commit?: boolean, row?: string }} values the parsed flags
 * @param {object} plan the applied plan (files and signoff receipts)
 * @param {object[]} applied the applied decision records
 * @param {Function} commitAppliedRows the spec cell's commit step, passed in so this file imports no further cell
 * @returns {{ committed: boolean, commit?: string } | null} null when --commit was not given
 */
export function commitApplyRow(root, { commit, row }, plan, applied, commitAppliedRows) {
  if (!commit) return null;
  const git = checkoutGit(root);
  const person = { name: git(['config', 'user.name']), email: git(['config', 'user.email']) };
  const decided = applied.find(record => record.id === row);
  // The clean check ran before the write; the plan's own files are what make the tree dirty now.
  const afterWrite = args => args[0] === 'status' ? '' : git(args);
  const result = commitAppliedRows(root, plan, { enabled: commitOnApplyEnabled(), row: { id: row, decision: decided?.decision ?? 'approve' }, person }, { git: afterWrite });
  return result.committed ? { committed: true, commit: result.commit } : { committed: false };
}
