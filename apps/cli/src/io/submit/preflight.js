/** `pullboard submit --preflight`: every registered static check runs in its own process at once and every failure is reported together [C7]. */
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const CHANGED_STATIC = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/src/io/changed/static.js')).href;
const REGISTRY = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/src/io/static/check/registry.js')).href;
const LIST_CHILD = `const { STATIC_CHECKS } = await import(${JSON.stringify(REGISTRY)}); process.stdout.write(JSON.stringify(STATIC_CHECKS.map(check => check.name)));`;
const CHILD = `const { changedStaticFailures } = await import(${JSON.stringify(CHANGED_STATIC)});
const [root, name, files] = process.argv.slice(1);
const failures = changedStaticFailures(root, JSON.parse(files), { only: [name] });
if (failures.length) process.stderr.write(failures.join('\\n') + '\\n');
process.exitCode = failures.length ? 1 : 0;`;

/**
 * Run one registered check in a child process.
 *
 * @param {string} root - Checkout root.
 * @param {string} name - Registered check name.
 * @param {string[]} files - Root-relative changed files.
 * @returns {Promise<{ name: string, failures: string[], ms: number }>}
 */
function runOne(root, name, files) {
  const started = performance.now();
  return new Promise(done => {
    const child = spawn(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', CHILD, root, name, JSON.stringify(files)], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    let text = '';
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', error => done({ name, failures: [`${name}: could not start (${error.message})`], ms: performance.now() - started }));
    child.on('close', code => done({ name, failures: code === 0 ? [] : text.split('\n').filter(Boolean), ms: performance.now() - started }));
  });
}

/**
 * The registered check names, read in a child so this cell takes no import edge into the gate cell.
 *
 * @param {string} root - Checkout root.
 * @returns {Promise<string[]>}
 */
function registeredNames(root) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', LIST_CHILD], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.on('error', fail);
    child.on('close', code => { if (code === 0) done(JSON.parse(text)); else fail(new Error('could not list the registered static checks')); });
  });
}

/**
 * Run every registered static check in parallel on the changed files and collect all failures from all of them.
 *
 * @param {string} root - Checkout root.
 * @param {string[]} files - Root-relative changed files.
 * @returns {Promise<{ ok: boolean, results: { name: string, failures: string[], ms: number }[], ms: number }>}
 */
export async function runPreflight(root, files) {
  const started = performance.now();
  const results = await Promise.all((await registeredNames(root)).map(name => runOne(root, name, files)));
  return { ok: results.every(row => !row.failures.length), results, ms: performance.now() - started };
}

/**
 * Print the preflight report: one line per failure grouped by check, then one summary line.
 *
 * @param {{ ok: boolean, results: object[], ms: number }} report
 * @param {(text: string) => void} write
 * @returns {number} exit code
 */
export function reportPreflight(report, write) {
  for (const row of report.results) for (const failure of row.failures) write(`${row.name}: ${failure}`);
  const failed = report.results.filter(row => row.failures.length);
  write(report.ok ? `preflight clean: ${report.results.length} checks in ${(report.ms / 1000).toFixed(1)}s` : `preflight red: ${failed.length} of ${report.results.length} checks failed (${failed.map(row => row.name).join(', ')}) in ${(report.ms / 1000).toFixed(1)}s`);
  return report.ok ? 0 : 1;
}
