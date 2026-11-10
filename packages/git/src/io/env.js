/** Git's repository-local variable names, asked once per Git implementation and PATH [C7]. */
import {
  currentGitAdapter,
  gitSpawnSync,
} from './adapter.js';

/** Successful answers by Git adapter, then by the PATH and exec path that choose the Git binary. */
const answers = new WeakMap();

/**
 * Run `git rev-parse --local-env-vars` once per adapter, PATH and GIT_EXEC_PATH, and replay its result after that.
 * Why: the list is compiled into the Git binary and does not depend on the folder, yet gitChildEnv asked for it
 * before every Git call; a submit cells check spent 380 of its 989 Git processes on it (#3896). A failed answer is
 * never kept, so the next call asks again.
 *
 * @param {string} root The folder Git runs in.
 * @param {NodeJS.ProcessEnv} env The discovery environment.
 * @returns {{ status: number|null, stdout: string }}
 */
export function localEnvVars(root, env) {
  const adapter = currentGitAdapter();
  const known = answers.get(adapter) ?? new Map();
  const key = `${env.PATH ?? ''}\0${env.GIT_EXEC_PATH ?? ''}`;
  if (known.has(key)) return known.get(key);
  const result = gitSpawnSync(['rev-parse', '--local-env-vars'], { cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.status === 0 && typeof result.stdout === 'string') {
    known.set(key, { status: 0, stdout: result.stdout });
    answers.set(adapter, known);
  }
  return result;
}
