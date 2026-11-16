/** The runner worker may import only from a reviewed list of packages; reach outside it is refused [C7]. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const WORKER_IMPORTS_FILE = 'packages/gate/data/baselines/worker-imports.json';
const MEASURE_TIMEOUT_MS = 60_000;

/**
 * The top-level units (`packages/<name>` or `apps/<name>`) the worker's import closure reaches, read in a child process.
 * Why a child: the gate names no runners import; the closure is the runners cell's answer for the tree under test.
 *
 * @param {string} root - Checkout root.
 * @returns {{units: string[]} | {error: string}} The sorted units, or why they could not be read.
 */
export function workerClosureUnits(root) {
  const entry = JSON.stringify(pathToFileURL(join(root, 'packages/runners/index.js')).href);
  const program = `const { runnerPackage } = await import(${entry});\nconst units = new Set();\nfor (const file of Object.keys(runnerPackage(${JSON.stringify(root)}).files)) { const m = /^(packages|apps)\\/([^/]+)\\//u.exec(file); if (m) units.add(m[1] + '/' + m[2]); }\nprocess.stdout.write(JSON.stringify([...units].sort()));`;
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', program], { cwd: root, encoding: 'utf8', timeout: MEASURE_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (child.status !== 0) return { error: (child.stderr ?? '').trim().split('\n').filter(Boolean).at(-1) ?? 'the measuring process did not start' };
  return { units: JSON.parse(child.stdout) };
}

/**
 * Findings for every unit the worker reaches that its reviewed list does not name, as `path:line: text` rows.
 *
 * @param {string} root - Checkout root.
 * @param {{ read?: (root: string) => {units: string[]} | {error: string} }} [options] - Closure reader, replaceable in tests.
 * @returns {string[]} One row per unit outside the list; one row when the closure cannot be read.
 */
export function workerImportProblems(root, { read = workerClosureUnits } = {}) {
  const allowed = new Set(JSON.parse(readFileSync(join(root, WORKER_IMPORTS_FILE), 'utf8')).units);
  const closure = read(root);
  if (closure.error) return [`${WORKER_IMPORTS_FILE}:1: the runner worker's imports could not be read: ${closure.error}`];
  return closure.units.filter(unit => !allowed.has(unit))
    .map(unit => `${WORKER_IMPORTS_FILE}:1: the runner worker now reaches ${unit}, outside its reviewed list; cut the import, or add ${unit} to the list in a change a reviewer sees`);
}
