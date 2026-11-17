/** `pullboard submit --preflight`: every registered static check runs in its own process at once and every failure is reported together [C7]. */
import { spawn } from 'node:child_process';
import { Refused } from '../../../../../packages/kernel/light.js';
import { git } from '../../../../../packages/git/index.js';
import { residentChecks } from '../../../../../packages/config/index.js';
import { callResident } from '../resident/client.js';
import { checkReceiptKey } from '../../../../../packages/git/index.js';
import { readCheckReceipt } from '../../../../../packages/git/index.js';
import { receiptLine } from '../../../../../packages/git/index.js';
import { writeCheckReceipt } from '../../../../../packages/git/index.js';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const CHANGED_STATIC = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/src/io/changed/static.js')).href;
// The file runStaticChecks names as its code: a preflight receipt keyed the same way is the one review and check cite [V4].
const STATIC_CHECK_CODE = resolve(import.meta.dirname, '../../../../../packages/gate/src/io/static/check.js');
const REGISTRY = pathToFileURL(resolve(import.meta.dirname, '../../../../../packages/gate/src/io/static/check/registry.js')).href;
const LIST_CHILD = `const { STATIC_CHECKS } = await import(${JSON.stringify(REGISTRY)}); process.stdout.write(JSON.stringify(STATIC_CHECKS.map(check => check.name)));`;
const CHILD = `const { changedStaticFailures } = await import(${JSON.stringify(CHANGED_STATIC)});
const [root, name, files] = process.argv.slice(1);
const failures = changedStaticFailures(root, JSON.parse(files), { only: [name] });
if (failures.length) process.stderr.write(failures.join('\\n') + '\\n');
process.exitCode = failures.length ? 1 : 0;`;

/** Checks that judge the whole tree whatever files changed. */
const TREE_CHECKS = new Set(['sync-spawn-in-leases', 'no-runtime-assumptions', 'store-registry', 'layout', 'compat-toggles', 'engine-folder']);

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
    const child = spawn(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', CHILD, root, name, JSON.stringify(files)], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
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
export async function runPreflight(root, files, { lean = false, resident = residentChecks() } = {}) {
  const started = performance.now();
  // A lean (submit) run skips the whole-tree checks when no changed file is code or config: the tree is then main's accepted tree,
  // which the gate already judged, and each skipped scan costs a process and 0.4-0.7 s of a loaded runner's submit [C7].
  const codeChanged = !lean || files.some(file => /^(?:src|packages|apps)\//u.test(file) || !file.includes('/'));
  // With submit.residentChecks on, a running resident process answers all the checks at once and no node child starts;
  // none running, busy, or on other code hands the call back and the children run as before [C7,#5330].
  const answered = resident ? await callResident('preflight', { root, files, skip: codeChanged ? [] : [...TREE_CHECKS] }, { cwd: root }) : null;
  if (Array.isArray(answered?.results)) return { ok: answered.results.every(row => !row.failures.length), results: answered.results, ms: performance.now() - started };
  const names = (await registeredNames(root)).filter(name => codeChanged || !TREE_CHECKS.has(name));
  const results = await Promise.all(names.map(name => runOne(root, name, files)));
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

/** The files added, copied, modified or renamed from `base` to `head`, root-relative. */
export function changedSince(root, base, head) {
  return git(root, ['diff', '--name-only', '-z', '--diff-filter=ACMR', base, head]).split('\0').filter(Boolean);
}

/** Pullboard's own static checker in a configured staticChecks command: its registered checks run on the changed files alone. */
const OWN_CHECKER = /\bapps\/cli\/src\/io\/static\/checks\.js\b/u;

/**
 * Run a project's configured static check command in `root` as one check named staticChecks, keeping its output's
 * last 40 lines as the failures when it exits non-zero or outlasts `timeoutMs`.
 *
 * @param {string} root - Checkout root.
 * @param {string} command - The configured staticChecks shell command.
 * @returns {Promise<{ name: string, failures: string[], ms: number }>}
 */
function runConfigured(root, command, timeoutMs) {
  const started = performance.now();
  return new Promise(done => {
    const child = spawn(command, { shell: true, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; });
    child.stderr.on('data', chunk => { text += chunk; });
    child.on('error', error => done({ name: 'staticChecks', failures: [`could not start (${error.message})`], ms: performance.now() - started }));
    child.on('close', (code, signal) => done({ name: 'staticChecks', ms: performance.now() - started, failures: code === 0 ? []
      : [...text.split('\n').filter(Boolean).slice(-40), `${command} ${signal ? `stopped by ${signal}` : `exited ${code}`}`] }));
  });
}

/**
 * Run the configured static check in this checkout: Pullboard's own checker runs its registered checks on the changed
 * files; any other project's command runs as configured. An empty command checks nothing.
 *
 * @param {string} root - Checkout root.
 * @param {string|undefined} command - The configured staticChecks command.
 * @param {string[]} files - Root-relative changed files.
 * @param {{ timeoutMs?: number }} [options] - timeoutMs: the configured check timeout; unset runs up to 10 minutes.
 * @returns {Promise<{ ok: boolean, results: { name: string, failures: string[], ms: number }[], ms: number, receipt?: object | null, reused?: boolean }>}
 */
export async function runStaticPreflight(root, command, files, { timeoutMs, lean = false } = {}) {
  const started = performance.now();
  if (!command?.trim()) return { ok: true, results: [], ms: 0 };
  if (OWN_CHECKER.test(command)) return runPreflight(root, files, { lean });
  // A green run on this exact tree, command, config and runner code is cited, not repeated: an unchanged resubmit, and a
  // review's check of the same tree, reuse it as runStaticChecks would (#2230). Pullboard's own checker above judges only
  // the changed files, so it never records a whole-tree receipt.
  const key = checkReceiptKey(root, { kind: 'static', definition: command.trim(), config: { staticChecks: command.trim(), timeoutMs: timeoutMs ?? null }, code: [STATIC_CHECK_CODE] });
  const kept = readCheckReceipt(root, key);
  if (kept) {
    process.stderr.write(`${receiptLine(kept)}\n`);
    return { ok: true, results: [], ms: performance.now() - started, receipt: kept, reused: true };
  }
  const result = await runConfigured(root, command.trim(), timeoutMs ?? 600_000);
  const ok = !result.failures.length;
  return { ok, results: [result], ms: performance.now() - started, ...(ok ? { receipt: writeCheckReceipt(root, key, { by: 'submit preflight' }) } : {}) };
}

/**
 * Refuse GATE_RED when the configured static check is red in this checkout, before any runner is queued.
 * Why: 80 of 233 red gates in 72 h waited in the queue and took a runner trip to fail a check that takes seconds (#5730).
 */
export async function requireStaticPreflight(root, command, files, options) {
  const report = await runStaticPreflight(root, command, files, { ...options, lean: true });
  if (report.ok) return report;
  const lines = [];
  reportPreflight(report, line => lines.push(line));
  throw new Refused('GATE_RED', `preflight is red; no runner was queued. Fix the named source, commit, and submit again:\n${lines.join('\n')}`, 'fix the named source, commit, and run pullboard submit <id> again');
}
