/** Classify NODE_OPTIONS as known or foreign; each cell declares the preloads it owns [C7]. */
export const RUNNER_PRELOAD_ENV = 'PULLBOARD_RUNNER_PRELOAD';

const known = new Set();
const proofs = { runner: () => false, runtime: () => false };

/** Declare a NODE_OPTIONS token that is this checkout's own; an undeclared token stays foreign. */
export function declareKnownNodeOption(token) { known.add(token); }

/** Declare how the owner proves a runner preload (from the env value) and a runtime recorder (from the token). */
export function declareNodeOptionProofs({ runner, runtime }) { Object.assign(proofs, { runner, runtime }); }

/** Whether NODE_OPTIONS may load a module not declared known or proven; foreign runs are neither short nor browser-free. */
export function foreignNodeOptions(value, env) {
  const declared = env[RUNNER_PRELOAD_ENV], own = proofs.runner(declared) ? declared : null;
  return String(value ?? '').split(/\s+/u).filter(Boolean).some(token => token !== own && !known.has(token) && !proofs.runtime(token));
}
