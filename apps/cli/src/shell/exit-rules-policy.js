/** Decide from committed policy whether exit rules apply, loading none of the board, stats or session modules [C7]. */
import { Refused } from '../../../../packages/kernel/index.js';
import {
  mainPolicy,
  policyAt,
  trunkRef,
} from '../../../../packages/sandbox/src/shell/trusted-policy-read.js';
import {
  repoInfo,
  tryGit,
} from '../../../../packages/git/index.js';

/**
 * True when this checkout is a linked worktree whose committed main policy enables exit rules. A plain read never
 * needs the exit-rules runtime, so run-command imports that runtime only when this answers true; it never loads
 * the board or the full read context, so `show` and `list` stay off the heavy modules.
 */
export async function exitRulesApply(io, command) {
  if (['init', 'settings', 'hook', 'mcp', 'view', 'serve'].includes(command)) return false;
  let info;
  try { info = repoInfo(io.cwd); }
  catch (error) { if (['NO_REPO', 'NOT_A_REPO', 'NO_CONFIG'].includes(error.code)) return false; throw error; }
  if (info.isMain) return false;
  let policy;
  try { policy = mainPolicy(info.root); }
  catch (error) {
    if (!(error instanceof Refused) || error.code !== 'NO_POLICY') throw error;
    const ref = trunkRef(info.root);
    const resolved = ref && tryGit(info.root, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (!resolved || resolved.status !== 0) throw error;
    policy = policyAt(info.root, resolved.stdout.trim());
  }
  return policy.config.exitRules?.enabled === true;
}
