/** Audit executions explicitly select real adapters locally and on remote runners [C7]. */
export function auditAdapterEnvironment(audit) {
  return audit ? { PULLBOARD_TEST_REAL: 'all', PULLBOARD_ADAPTER_AUDIT: '1' } : {};
}

/** The network-facing boundaries that register in the adapter switch beside Git, keyed by the name PULLBOARD_TEST_REAL lists [C7]. */
export const NETWORK_BOUNDARIES = Object.freeze(['network', 'board-api']);

/**
 * Pick the real or fake adapter for one network-facing boundary: the run chooses through its environment, one test overrides with a mode, and an audit is always real.
 * Why: the scheduled audit must exercise the real network and board API even when a test asks for a fake, as the Git switch does [C7].
 */
export function selectBoundaryAdapter(boundary, { fake, real, env = {}, mode } = {}) {
  if (!NETWORK_BOUNDARIES.includes(boundary)) throw new TypeError(`unknown adapter boundary ${String(boundary)}; registered: ${NETWORK_BOUNDARIES.join(', ')}`);
  if (!fake || !real) throw new TypeError(`${boundary} adapter switch needs a fake and a real adapter`);
  if (mode !== undefined && !['real', 'fake'].includes(mode)) throw new TypeError(`choose real or fake for ${boundary}, not ${String(mode)}`);
  if (env.PULLBOARD_ADAPTER_AUDIT === '1') return real;
  if (mode) return mode === 'real' ? real : fake;
  const names = String(env.PULLBOARD_TEST_REAL ?? '').split(',').map((name) => name.trim());
  return names.includes('all') || names.includes(boundary) ? real : fake;
}
