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
import { hookRunnerWanted } from './runner.js';
import { stagedOnRunner } from './runner.js';

/** The checkout this CLI runs from: the staged tree when the hook is composed (#2593). */
const TREE = fileURLToPath(new URL('../../../../../', import.meta.url));

/** The checks PULLBOARD_HOOK_STATIC may name: exactly the header's declared loads, shipped then test-only. */
export const HOOK_STATIC_CHECKS = Object.freeze(['packages/gate/src/io/changed/scripts/static.js', 'apps/cli/tests/fixtures/hook/static.js']);

/**
 * The failures of the named staged check, one `path:line: message` each; none when no check is named. A path only a
 * companion patch changes is left out, as the commit's own lane checks leave it out. With the hook's context, the check
 * runs first as one runner job when a runner is free, and here only when no runner answers in time [C7,#12570].
 * Why: on 20 Nov 34 of 37 commits hit the 120 s HOOK_TIMEOUT running this check on a host at load 55-162.
 *
 * @param {string} root the committing checkout
 * @param {NodeJS.ProcessEnv} env
 * @param {{ ctx?: object | null, main?: string | null, wanted?: (env: NodeJS.ProcessEnv) => boolean, onRunner?: (ctx: object, options: object) => Promise<string[] | null>, say?: (line: string) => void }} [runner]
 *   ctx: the hook's CLI context, without which the check always runs here; main: accepted main's commit; wanted and
 *   onRunner replace the runner decision and the job, for a test.
 * @returns {Promise<string[]>}
 */
export async function stagedStaticProblems(root, env, { ctx = null, main = null, wanted = hookRunnerWanted, onRunner = stagedOnRunner, say } = {}) {
  const named = env.PULLBOARD_HOOK_STATIC;
  if (!named) return [];
  const file = resolve(TREE, named);
  const path = relative(TREE, file).split('\\').join('/');
  if (!HOOK_STATIC_CHECKS.includes(path)) return [`PULLBOARD_HOOK_STATIC names ${named}, which apps/cli/src/io/hook/static.js does not declare; name one of ${HOOK_STATIC_CHECKS.join(', ')}`];
  const companions = new Set(JSON.parse(env.PULLBOARD_HOOK_COMPANION_PATHS || '[]'));
  const own = (line) => !companions.has(line.slice(0, line.indexOf(':')));
  const answered = ctx && wanted(env) ? await onRunner(ctx, { main, check: path, ...(say ? { say } : {}) }) : null;
  if (answered) return answered.filter(own);
  const { stagedHookFailures } = await loadStaged(file);
  return stagedHookFailures(root).filter(own);
}

/**
 * The named staged-check module, loaded at its file path. Why: the one computed import this file declares, so both readers share it [P3,#10242].
 *
 * @param {string} file - Absolute path of a declared staged check.
 * @returns {Promise<Record<string, any>>}
 */
function loadStaged(file) {
  return import(pathToFileURL(file).href);
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
  const module = await loadStaged(file);
  const tables = module.CEILING_ROW_TABLES ?? {};
  const covered = module.splitRowCovered;
  return typeof covered === 'function' ? Object.fromEntries(Object.entries(tables).map(([path, shape]) => [path, path.endsWith('/cells-edges.json') ? { ...shape, splitCovered: covered } : shape])) : tables;
}
