/** Injectable Git process boundary; production retains Node's exact process and stream behavior [C7]. */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  execFileSync,
  spawn,
  spawnSync,
} from 'node:child_process';

const adapters = new AsyncLocalStorage();

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
  return currentGitAdapter().spawnSync(args, options);
}

/** Run a throwing synchronous Git process through this call chain's implementation. */
export function gitExecFileSync(args, options) {
  return currentGitAdapter().execFileSync(args, options);
}

/** Start a streaming Git process through this call chain's implementation. */
export function gitSpawn(args, options) {
  return currentGitAdapter().spawn(args, options);
}
