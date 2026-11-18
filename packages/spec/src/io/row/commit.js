/** Write an approved row to the spec file and commit it under the person's identity, only when asked and the checkout is clean [C7,#1310,#9346]. */
import { Refused } from '../../../../kernel/index.js';
import { planViewApproval } from '../../logic/row/apply-plan.js';
import { SIGNOFFS_FILE } from '../main.js';
import { writeRowApply } from './decisions.js';

/** Run the injected git; a failing command refuses with git's own first line. */
function run(git, args) {
  try { return String(git(args) ?? ''); }
  catch (error) { throw new Refused('APPLY_COMMIT_FAILED', `git ${args[0]} failed: ${String(error?.message ?? error).trim().split('\n')[0]}`, 'fix what git names, then run pullboard spec apply'); }
}

/**
 * Apply a preflighted row-apply plan and commit it as one commit authored by the person, holding only the changed spec files and
 * new signoff receipts. The repo's hooks run; nothing bypasses them. With the setting off, or nothing to change, it does nothing.
 * Why: a dirty checkout would sweep unrelated work into the person's commit, so it refuses before writing and names the one command left.
 *
 * @param {string} root - The checkout.
 * @param {{ files: Array<{ file: string }>, signoffs: { receipts: unknown[] } }} plan - From planRowApply.
 * @param {{ enabled: boolean, row: { id: string, decision: 'approve'|'decline' }, person: { name: string, email: string } }} options - `enabled` is spec.commitOnApply.
 * @param {{ git: (args: string[]) => string }} io - Runs git in the checkout and returns its output, throwing on failure; the caller owns the process.
 * @returns {{ committed: false } | { committed: true, commit: string, paths: string[], message: string }}
 */
export function commitAppliedRows(root, plan, { enabled, row, person }, { git }) {
  if (enabled !== true) return { committed: false };
  const paths = [...plan.files.map((file) => file.file), ...(plan.signoffs.receipts.length ? [SIGNOFFS_FILE] : [])];
  if (!paths.length) return { committed: false };
  const clean = run(git, ['status', '--porcelain']).trim() === '';
  const outcome = planViewApproval(row, { clean }, person);
  if (outcome.action === 'left') throw new Refused('APPLY_NOT_COMMITTED', outcome.why, outcome.command);
  writeRowApply(root, plan);
  run(git, ['add', '--', ...paths]);
  run(git, ['commit', '-q', '-m', outcome.message, '--author', outcome.author, '--', ...paths]);
  return { committed: true, commit: run(git, ['rev-parse', 'HEAD']).trim(), paths, message: outcome.message };
}
