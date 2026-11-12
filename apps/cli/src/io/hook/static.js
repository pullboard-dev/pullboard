/**
 * The staged static check a self-hosted pre-commit names with PULLBOARD_HOOK_STATIC, run inside the hook's own process.
 * Why: .githooks ran it as a separate cold node first, about 5 s of imports per commit that no timer saw (#5719).
 */
import {
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

/** The checkout this CLI runs from: the staged tree when the hook is composed (#2593). */
const TREE = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * The failures of the named staged check, one `path:line: message` each; none when no check is named. A path only a
 * companion patch changes is left out, as the commit's own lane checks leave it out.
 *
 * @param {string} root the committing checkout
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string[]>}
 */
export async function stagedStaticProblems(root, env) {
  const named = env.PULLBOARD_HOOK_STATIC;
  if (!named) return [];
  const file = resolve(TREE, named);
  if (relative(TREE, file).startsWith('..')) return [`PULLBOARD_HOOK_STATIC names ${named}, outside this checkout; name a file inside it`];
  const { stagedHookFailures } = await import(pathToFileURL(file).href);
  const companions = new Set(JSON.parse(env.PULLBOARD_HOOK_COMPANION_PATHS || '[]'));
  return stagedHookFailures(root).filter((line) => !companions.has(line.slice(0, line.indexOf(':'))));
}
