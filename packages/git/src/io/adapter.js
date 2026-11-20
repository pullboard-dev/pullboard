/** Injectable Git process boundary; production retains Node's exact process and stream behavior [C7]. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Refused } from '../../../kernel/browser.js';
import { accessSync } from 'node:fs';
import { constants } from 'node:fs';
import { delimiter } from 'node:path';
import { join } from 'node:path';
import {
  execFileSync,
  spawn,
  spawnSync,
} from 'node:child_process';

const adapters = new AsyncLocalStorage();
const selections = new AsyncLocalStorage();
const projectReads = new AsyncLocalStorage();
export const PROJECT_GIT_ATTEMPTS = 3; // budget: a slow read is retried twice, so a project is skipped only after 3 timeouts in a row.
export const PROJECT_GIT_TIMEOUT_MS = 5_000; // budget: one unreachable registered repo cannot retain an interactive discovery command.

/** Bound every Git process in one project inspection; nested inspections and concurrent requests retain their own root. */
export function withProjectGitTimeout(root, work, { timeoutMs = PROJECT_GIT_TIMEOUT_MS } = {}) {
  if (typeof root !== 'string' || !root || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('project Git reads need a root and positive timeout');
  const parent = projectReads.getStore();
  const bound = Math.min(timeoutMs, parent?.timeoutMs ?? timeoutMs);
  // A nested read of the same root belongs to the outer retry; retrying inside it multiplied the attempts (3 x 3 x 5 s) past the discovery bound [C7].
  if (parent?.root === root) return projectReads.run({ root, timeoutMs: bound, last: parent.last }, work);
  // A read that timed out under load (an API restart, a busy disk) tries again before the project is skipped; the last try says so [C7].
  for (let attempt = 1; ; attempt += 1) {
    try { return projectReads.run({ root, timeoutMs: bound, last: attempt >= PROJECT_GIT_ATTEMPTS }, work); }
    catch (error) { if (attempt >= PROJECT_GIT_ATTEMPTS || error?.code !== 'BOARD_UNAVAILABLE' || !error.projectTimeout) throw error; }
  }
}

/** Retain a caller's tighter bound and terminate only the Git process owned by this inspection. */
function projectOptions(options) {
  const scope = projectReads.getStore();
  if (!scope) return options;
  const timeout = options?.timeout > 0 ? Math.min(options.timeout, scope.timeoutMs) : scope.timeoutMs;
  return { ...options, timeout, killSignal: 'SIGKILL' };
}

/** A timed-out observation is unreachable, never a missing repository or a clean Git result. */
function projectTimeout(error, options) {
  const scope = projectReads.getStore();
  if (!scope || error?.code !== 'ETIMEDOUT') return null;
  const message = `registered project ${scope.root} is unreachable: Git timed out after ${options.timeout}ms; ${scope.last ? 'skipping this project' : 'retrying'}`;
  process.stderr.write(`pullboard: ${message}\n`);
  const refusal = new Refused('BOARD_UNAVAILABLE', message, `restore the repository or run pullboard forget ${JSON.stringify(scope.root)}`);
  refusal.projectTimeout = true;
  return refusal;
}

const SHIM = '/usr/bin/git';

/** Pick the git binary to spawn: the first PATH git that is not the macOS shim, else what xcrun names, else plain git [C7]. */
export function resolveGitPath({ path = process.env.PATH ?? '', executable = isExecutable, xcrun = xcrunGit } = {}) {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, 'git');
    if (candidate !== SHIM && executable(candidate)) return candidate;
  }
  try { return xcrun() || 'git'; } catch { return 'git'; }
}

function isExecutable(file) {
  try { accessSync(file, constants.X_OK); return true; } catch { return false; }
}

/** Ask xcrun for the real git behind the shim; a failure or empty answer is left to the caller. */
function xcrunGit() {
  const found = launchSync('xcrun', ['-f', 'git'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return found.status === 0 ? String(found.stdout).trim() : '';
}

/** The one synchronous launch of this file: git and the xcrun lookup share it, so the leased-work call count does not grow. */
function launchSync(command, args, options) { return spawnSync(command, args, options); }

const resolvedGit = new Map();
/**
 * The git binary for one PATH, resolved on first use and reused: each call through the shim cost two execs.
 * Why per PATH, rechecked: one long-lived process kept the first git it found, so a caller with another PATH, or any
 * command after that git was removed, spawned a missing file and read it as NOT_A_REPO [C7].
 *
 * @param {string} [path] - The PATH the call runs under; the process PATH when left out.
 * @returns {string}
 */
export function realGitPath(path = process.env.PATH ?? '') {
  const known = resolvedGit.get(path);
  if (known !== undefined && (!known.includes('/') || isExecutable(known))) return known;
  const found = resolveGitPath({ path });
  resolvedGit.set(path, found);
  return found;
}

/** The PATH one Git call runs under: its own environment's, else this process's. */
function callPath(options) {
  return options?.env?.PATH ?? process.env.PATH ?? '';
}

/** The real implementation forwards every argument and option without interpreting Git output. */
export const realGitAdapter = Object.freeze({
  /** Run a synchronous Git process and preserve its complete Node result. */
  spawnSync(args, options) { return launchSync(realGitPath(callPath(options)), args, options); },
  /** Run Git with Node's throwing synchronous contract, including binary output. */
  execFileSync(args, options) { return execFileSync(realGitPath(callPath(options)), args, options); },
  /** Start a streaming Git process; framing remains the caller's responsibility. */
  spawn(args, options) { return spawn(realGitPath(callPath(options)), args, options); },
});

/** Return the implementation belonging to this async call chain, defaulting to real Git. */
export function currentGitAdapter() {
  return adapters.getStore() ?? realGitAdapter;
}

export function needAdapter(adapter) {
  const method = ['spawnSync', 'execFileSync', 'spawn'].find(name => typeof adapter?.[name] !== 'function');
  if (method) throw new TypeError(`Git adapter needs ${method}`);
}
export { adapters, selections };

/** Select an implementation for one call chain; concurrent and nested work cannot change its peers. */
export function withGitAdapter(adapter, work) {
  needAdapter(adapter);
  const forced = selections.getStore()?.audit || process.env.PULLBOARD_ADAPTER_AUDIT === '1';
  return adapters.run(forced ? realGitAdapter : adapter, work);
}

/** Contract suites explicitly exercise both implementations even during an audit. */
export function withGitContractAdapter(adapter, work) {
  needAdapter(adapter);
  return adapters.run(adapter, work);
}

/** Run a synchronous Git process through this call chain's implementation. */
export function gitSpawnSync(args, options) {
  const bounded = projectOptions(options);
  try {
    const result = currentGitAdapter().spawnSync(args, bounded);
    const failure = projectTimeout(result.error, bounded);
    if (failure) throw failure;
    return result;
  } catch (error) { throw projectTimeout(error, bounded) ?? error; }
}

/** Run a throwing synchronous Git process through this call chain's implementation. */
export function gitExecFileSync(args, options) {
  const bounded = projectOptions(options);
  try { return currentGitAdapter().execFileSync(args, bounded); }
  catch (error) { throw projectTimeout(error, bounded) ?? error; }
}

/** Start a streaming Git process through this call chain's implementation. */
export function gitSpawn(args, options) {
  return currentGitAdapter().spawn(args, projectOptions(options));
}

/** Bind fake/real implementations to one test run without affecting production callers. */
export function withGitSelection({ fake, real = realGitAdapter, env = process.env }, work) {
  for (const adapter of [fake, real]) for (const method of ['spawnSync', 'execFileSync', 'spawn']) {
    if (typeof adapter?.[method] !== 'function') throw new TypeError(`Git adapter needs ${method}`);
  }
  const audit = env.PULLBOARD_ADAPTER_AUDIT === '1';
  const names = String(env.PULLBOARD_TEST_REAL ?? '').split(',').map(name => name.trim());
  const selection = { fake, real, audit };
  return selections.run(selection, () => withGitAdapter(audit || names.includes('all') || names.includes('git') ? real : fake, work));
}

/** Override just this async test chain; an audit cannot be downgraded to a fake. */
export function withGitMode(mode, work) {
  const selection = selections.getStore();
  if (!selection || !['real', 'fake'].includes(mode)) throw new TypeError('choose real or fake inside a Git selection');
  return withGitAdapter(selection.audit || mode === 'real' ? selection.real : selection.fake, work);
}
