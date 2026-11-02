/** Injectable Git process boundary; production retains Node's exact process and stream behavior [C7]. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Refused } from '../../../kernel/index.js';
import {
  execFileSync,
  spawn,
  spawnSync,
} from 'node:child_process';

const adapters = new AsyncLocalStorage();
const projectReads = new AsyncLocalStorage();
export const PROJECT_GIT_TIMEOUT_MS = 5_000; // budget: one unreachable registered repo cannot retain an interactive discovery command.

/** Bound every Git process in one project inspection; nested inspections and concurrent requests retain their own root. */
export function withProjectGitTimeout(root, work, { timeoutMs = PROJECT_GIT_TIMEOUT_MS } = {}) {
  if (typeof root !== 'string' || !root || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError('project Git reads need a root and positive timeout');
  const parent = projectReads.getStore();
  return projectReads.run({ root, timeoutMs: Math.min(timeoutMs, parent?.timeoutMs ?? timeoutMs) }, work);
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
  const message = `registered project ${scope.root} is unreachable: Git timed out after ${options.timeout}ms; skipping this project`;
  process.stderr.write(`pullboard: ${message}\n`);
  return new Refused('BOARD_UNAVAILABLE', message, `restore the repository or run pullboard forget ${JSON.stringify(scope.root)}`);
}

/** The real implementation forwards every argument and option without interpreting Git output. */
export const realGitAdapter = Object.freeze({
  /** Run a synchronous Git process and preserve its complete Node result. */
  spawnSync(args, options) { return spawnSync('git', args, options); },
  /** Run Git with Node's throwing synchronous contract, including binary output. */
  execFileSync(args, options) { return execFileSync('git', args, options); },
  /** Start a streaming Git process; framing remains the caller's responsibility. */
  spawn(args, options) { return spawn('git', args, options); },
});

/** Return the implementation belonging to this async call chain, defaulting to real Git. */
export function currentGitAdapter() {
  return adapters.getStore() ?? realGitAdapter;
}

/** Select an implementation for one call chain; concurrent and nested work cannot change its peers. */
export function withGitAdapter(adapter, work) {
  for (const method of ['spawnSync', 'execFileSync', 'spawn']) {
    if (typeof adapter?.[method] !== 'function') throw new TypeError(`Git adapter needs ${method}`);
  }
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
