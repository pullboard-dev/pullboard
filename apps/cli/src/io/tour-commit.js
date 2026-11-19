/**
 * One scripted commit of `pullboard tour`: the checks git's pre-commit and commit-msg hooks would run, run through the
 * tour's own in-process pullboard dispatch, then the commit itself with git's hooks off [N10,#10408].
 *
 * Why: each hook was a shell script that started pullboard twice and the hook shim a third time, 1.5-3.7 s of node
 * starts per commit on an idle runner and 10-21 s on a loaded one. The same checks run here in the tour's process.
 */
import { writeFileSync } from 'node:fs';

/** What git runs for a commit, in git's order: the staged checks, then the message check that may rewrite the message. */
const HOOK_STEPS = Object.freeze(['pre-commit', 'commit-msg']);

/**
 * Commit with the hooks run in process, or with git's own hooks when `real` is set.
 *
 * @param {object} ports
 * @param {(file: string, args: string[], options: object) => string} ports.run - One real command as the committing agent.
 * @param {(args: string[], options: object) => Promise<string>} ports.pb - One pullboard command as the committing agent, in this process; a refusal throws.
 * @param {string} ports.message - The commit message.
 * @param {string} ports.messageFile - Where the commit-msg hook reads and may rewrite the message.
 * @param {string} ports.label - The command line the tour shows for the commit.
 * @param {boolean} [ports.all] - Commit every tracked change, as git commit -a.
 * @param {boolean} [ports.real] - Run git with its hooks as separate processes, as a person's commit does.
 * @returns {Promise<string>} The commit command's output.
 */
export async function commitWithHooks({ run, pb, message, messageFile, label, all = false, real = false }) {
  if (real) return run('git', ['commit', '-q', all ? '-am' : '-m', message], { label });
  // git -a stages into a temporary index for the hooks; here the tracked changes are staged first, so the hook reads the index git commits.
  if (all) run('git', ['add', '-u'], { label: '', show: null });
  await pb(['hook', HOOK_STEPS[0]], { label: '', show: null });
  writeFileSync(messageFile, `${message}\n`);
  await pb(['hook', HOOK_STEPS[1], messageFile], { label: '', show: null });
  return run('git', ['-c', 'core.hooksPath=/dev/null', 'commit', '-q', '-F', messageFile], { label });
}
