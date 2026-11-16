/** The pre-commit hook logic run inside the test process, for fixture commits that need its answer and not a Node start [C7,#9211]. */
import { runCliInProcess } from '../process.js';

/** The staged static check the repository's own .githooks/pre-commit names; the in-process run names the same one. */
export const PRE_COMMIT_STATIC = 'packages/gate/src/io/changed/scripts/static.js';

/**
 * Run `pullboard hook pre-commit` in the checkout at `cwd` through the production dispatcher, as git would run the hook.
 * Why: the real hook costs a Node start per commit; the dispatcher is the same code without it.
 *
 * @param {{ env: Record<string, string> }} box - A fixture box, whose env is the hook's environment.
 * @param {string} cwd - The checkout being committed in.
 * @param {{ staticCheck?: string }} [options] - The staged static check to name; '' names none, as a test of the rules alone wants (the real check needs node --experimental-vm-modules).
 * @returns {Promise<{ status: number, stderr: string }>} The hook's exit status and everything it printed to stderr.
 */
export async function runPreCommitInProcess(box, cwd, { staticCheck = PRE_COMMIT_STATIC } = {}) {
  const { status, stderr } = await runCliInProcess(['hook', 'pre-commit'], { cwd, env: { ...box.env, PULLBOARD_HOOK_STATIC: staticCheck } });
  return { status, stderr };
}
