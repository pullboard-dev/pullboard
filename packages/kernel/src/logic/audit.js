/** Audit executions explicitly select real adapters locally and on remote runners [C7]. */
export function auditAdapterEnvironment(audit) {
  return audit ? { PULLBOARD_TEST_REAL: 'all', PULLBOARD_ADAPTER_AUDIT: '1' } : {};
}

/** The network-facing boundaries that register in the adapter switch beside Git, keyed by the name PULLBOARD_TEST_REAL lists [C7]. */
export const NETWORK_BOUNDARIES = Object.freeze(['network', 'board-api']);

/** The key-file and GitHub/npm boundaries that register in the adapter switch beside the network ones, keyed by the name PULLBOARD_TEST_REAL lists [C7]. */
export const KEY_BOUNDARIES = Object.freeze(['keys', 'github-npm']);

/** The clock/timers and env/config boundaries that register in the adapter switch beside the key ones, keyed by the name PULLBOARD_TEST_REAL lists [C7]. */
export const CLOCK_ENV_BOUNDARIES = Object.freeze(['clock', 'env']);

/** The fs, process and git remote boundaries that register in the adapter switch beside the clock and env ones, keyed by the name PULLBOARD_TEST_REAL lists [C7]. */
export const FS_PROCESS_GIT_BOUNDARIES = Object.freeze(['fs', 'process', 'git-remote']);

const REGISTERED_BOUNDARIES = Object.freeze([...NETWORK_BOUNDARIES, ...KEY_BOUNDARIES, ...CLOCK_ENV_BOUNDARIES, ...FS_PROCESS_GIT_BOUNDARIES]);

/**
 * Pick the real or fake adapter for one network-facing boundary: the run chooses through its environment, one test overrides with a mode, and an audit is always real.
 * Why: the scheduled audit must exercise the real network and board API even when a test asks for a fake, as the Git switch does [C7].
 */
export function selectBoundaryAdapter(boundary, { fake, real, env = {}, mode } = {}) {
  if (!REGISTERED_BOUNDARIES.includes(boundary)) throw new TypeError(`unknown adapter boundary ${String(boundary)}; registered: ${REGISTERED_BOUNDARIES.join(', ')}`);
  if (!fake || !real) throw new TypeError(`${boundary} adapter switch needs a fake and a real adapter`);
  if (mode !== undefined && !['real', 'fake'].includes(mode)) throw new TypeError(`choose real or fake for ${boundary}, not ${String(mode)}`);
  if (env.PULLBOARD_ADAPTER_AUDIT === '1') return real;
  if (mode) return mode === 'real' ? real : fake;
  const names = String(env.PULLBOARD_TEST_REAL ?? '').split(',').map((name) => name.trim());
  return names.includes('all') || names.includes(boundary) ? real : fake;
}
