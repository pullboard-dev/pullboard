/** The repository's static checks run inside the test process, so a style test pays no node child launch [C7]. */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Run the static checks of the tree at `root` in this process and report them as the command would.
 * Why: apps/cli/src/io/static/checks.js launches a child per run; its two parts are plain functions, so a test can
 * call them from the checked tree and read the same findings without the launch. A fixture tree's own copies are
 * imported, so a source rule changed in that tree is the one that judges it.
 * @param {string} root checkout or fixture tree to judge
 * @returns {Promise<{ status: number, stdout: string, stderr: string }>} status 0 with no findings, 1 with them
 */
export async function runStaticChecks(root) {
  const load = async path => import(pathToFileURL(join(root, path)).href);
  const { runStaticTreeRegistry } = await load('packages/gate/src/io/static/registry.js');
  const { staticScopeFromEnv } = await load('packages/gate/index.js');
  const { STATIC_APPS } = await load('apps/cli/src/io/static/checks.js');
  const { viewPureGate } = await load('apps/cli/src/io/static/view.js');
  const findings = [
    ...runStaticTreeRegistry(root, { changed: staticScopeFromEnv(), apps: STATIC_APPS }),
    ...viewPureGate(root).failures.map(row => `${row.path}:${row.line}: ${row.text}`),
  ];
  return { status: findings.length ? 1 : 0, stdout: '', stderr: findings.length ? `${findings.join('\n')}\n` : '' };
}
