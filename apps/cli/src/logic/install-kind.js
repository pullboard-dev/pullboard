/** How Pullboard was installed, told from the script path alone so a caller can pick the matching update command [C7,#1303]. */

/** The path with backslashes as slashes and no trailing slash, so one comparison serves every platform. */
const normal = path => String(path ?? '').replaceAll('\\', '/').replace(/\/+$/u, '');

/** True when `path` lies strictly under folder `root`. */
const under = (path, root) => root !== '' && path.startsWith(`${root}/`);

/**
 * The install kind of the running script: "npx" under an _npx cache folder, "project" under the working folder's
 * node_modules, "global" under a global npm prefix's node_modules, and "unknown" otherwise.
 *
 * @param {{ scriptPath: string, env?: Record<string, string | undefined> }} input - The resolved script path and the environment (PWD names the working folder; npm_config_prefix or PREFIX names the global prefix).
 * @returns {'global' | 'npx' | 'project' | 'unknown'} The install kind.
 */
export function installKind({ scriptPath, env = {} }) {
  const path = normal(scriptPath);
  if (/(^|\/)_npx(\/|$)/u.test(path)) return 'npx';
  const cwd = normal(env.PWD);
  if (cwd !== '' && under(path, `${cwd}/node_modules`)) return 'project';
  const prefix = normal(env.npm_config_prefix ?? env.PREFIX);
  if (prefix !== '' && (under(path, `${prefix}/lib/node_modules`) || under(path, `${prefix}/node_modules`))) return 'global';
  return 'unknown';
}
