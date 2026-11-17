/** @pullboard-module-loads packages/gate/src/io/changed/scripts/static.js */
/** @pullboard-test-loads apps/cli/tests/fixtures/hook/static.js */
/**
 * The staged static check a self-hosted pre-commit names with PULLBOARD_HOOK_STATIC, run inside the hook's own process.
 * Why: .githooks ran it as a separate cold node first, about 5 s of imports per commit that no timer saw (#5719). The
 * header declares every module it may load, so each test reaching the hook keeps a closure key (#5840). The module
 * line names shipped source only, since the runner package copies what it names and ships no test fixture; the hook
 * test's fixture sits in the test-only line, which the package copy ignores.
 */
import {
  relative,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

/** The checkout this CLI runs from: the staged tree when the hook is composed (#2593). */
const TREE = fileURLToPath(new URL('../../../../../', import.meta.url));

/** The checks PULLBOARD_HOOK_STATIC may name: exactly the header's declared loads, shipped then test-only. */
export const HOOK_STATIC_CHECKS = Object.freeze(['packages/gate/src/io/changed/scripts/static.js', 'apps/cli/tests/fixtures/hook/static.js']);

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
  const path = relative(TREE, file).split('\\').join('/');
  if (!HOOK_STATIC_CHECKS.includes(path)) return [`PULLBOARD_HOOK_STATIC names ${named}, which apps/cli/src/io/hook/static.js does not declare; name one of ${HOOK_STATIC_CHECKS.join(', ')}`];
  const { stagedHookFailures } = await import(pathToFileURL(file).href);
  const companions = new Set(JSON.parse(env.PULLBOARD_HOOK_COMPANION_PATHS || '[]'));
  return stagedHookFailures(root).filter((line) => !companions.has(line.slice(0, line.indexOf(':'))));
}

/**
 * The source ceiling tables whose rows a lane may move between its own files, from the same gate module the staged
 * check loads, so the paths stay with the gate modules that own them (#10242). None when no check is named or the
 * named module holds no tables (a project that is not this repository).
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<Record<string, { files?: boolean, bare?: boolean }>>}
 */
export async function stagedCeilingTables(env) {
  const named = env.PULLBOARD_HOOK_STATIC;
  if (!named) return {};
  const file = resolve(TREE, named);
  if (!HOOK_STATIC_CHECKS.includes(relative(TREE, file).split('\\').join('/'))) return {};
  return (await import(pathToFileURL(file).href)).CEILING_ROW_TABLES ?? {};
}
