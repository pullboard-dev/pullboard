/** Injectable Git process boundary; production retains Node's exact process and stream behavior [C7]. */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  execFileSync,
  spawn,
  spawnSync,
} from 'node:child_process';

const adapters = new AsyncLocalStorage();
const selections = new AsyncLocalStorage();

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
  const forced = selections.getStore()?.audit || process.env.PULLBOARD_ADAPTER_AUDIT === '1';
  return adapters.run(forced ? realGitAdapter : adapter, work);
}

/** Contract suites explicitly exercise both implementations even during an audit. */
export function withGitContractAdapter(adapter, work) {
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
