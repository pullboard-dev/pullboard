/** A fixture commit that runs both hooks inside the test process and commits with the repository's hooks off [C7,#9215]. */
import { runFixtureChild } from '../../../../../packages/gate/tests/fixtures/child.js';
import { runCommitMsgInProcess } from './commit-msg.js';
import { runPreCommitInProcess } from './pre-commit.js';

/** The commit flags a hook-free commit may carry; any other flag (--amend, -F, -e, -a, -c ...) needs the real hooks. */
const PLAIN_FLAGS = new Set(['-q', '--quiet', '--allow-empty', '--allow-empty-message']);

/**
 * Parse `commit` arguments the in-process path can stand in for: plain flags and exactly one `-m <message>`.
 * Why: git's own message handling (editor, files, amend, staging with -a) is not reproduced, so such a commit keeps the real hooks.
 *
 * @param {string[]} args - The git arguments, `commit` first.
 * @returns {{ flags: string[], message: string } | null} The flags and the message, or null when the real hooks must run.
 */
export function plainCommitArgs(args) {
  if (args[0] !== 'commit') return null;
  const flags = [];
  let message = null;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '-m' && message === null && typeof args[i + 1] === 'string') { message = args[i + 1]; i += 1; } else if (PLAIN_FLAGS.has(args[i])) flags.push(args[i]);
    else return null;
  }
  return message === null ? null : { flags, message };
}

/**
 * Commit as `git commit -m` would with the repository's hooks: pre-commit, then commit-msg (which may rewrite the message),
 * then the commit itself with hooks off. Returns null when the real hooks must run instead.
 * Why: each real hook is a Node start; the dispatcher is the same code without it, and parity tests hold the two equal.
 * The answer is a promise, because the hooks run in this process; a refusal returns git's own status 1 and the hook's stderr, and a commit carries both hooks' stderr before git's.
 *
 * @param {{ env: Record<string, string> }} box - A fixture box, whose env is git's and the hooks' environment.
 * @param {string} cwd - The checkout being committed in.
 * @param {string[]} args - The git arguments, `commit` first.
 * @returns {Promise<{ status: number, stdout: string, stderr: string }> | null} The commit's answer, or null for the real hooks.
 */
export function commitInProcess(box, cwd, args) {
  const plain = plainCommitArgs(args);
  if (plain === null) return null;
  const git = (...rest) => runFixtureChild('git', rest, { cwd, env: box.env, encoding: 'utf8' });
  // With nothing staged git refuses before it runs any hook, so that case takes the real path.
  if (!plain.flags.includes('--allow-empty') && git('diff', '--cached', '--quiet').status === 0) return null;
  return (async () => {
    const pre = await runPreCommitInProcess(box, cwd, { staticCheck: '' });
    if (pre.status !== 0) return { status: 1, stdout: '', stderr: pre.stderr };
    const msg = await runCommitMsgInProcess(box, cwd, plain.message);
    if (msg.status !== 0) return { status: 1, stdout: '', stderr: msg.stderr };
    // git passes a passing hook's stderr through to the commit's own, so a note such as a partly staged file left unfixed reaches the caller here too [C7,#10655].
    const commit = git('-c', 'core.hooksPath=/dev/null', 'commit', ...plain.flags, '-m', msg.message);
    return { ...commit, stderr: `${pre.stderr}${msg.stderr}${commit.stderr}` };
  })();
}
