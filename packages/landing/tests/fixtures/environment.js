/** An in-process environment scope for landing cell tests: no child process, no CLI, nothing imported from another cell [C7]. */

let pending = Promise.resolve();

/** Restore an exact environment, including absent keys. */
function restoreEnvironment(saved) {
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(saved, key)) delete process.env[key];
  for (const [key, value] of Object.entries(saved)) process.env[key] = value;
}

/**
 * Await a body with process.env set to exactly `env`, then restore the prior environment, even when the body throws.
 * Why: the production calls read process.env, so a case needs its own; calls serialize here so two cases never overlap.
 *
 * @param {Record<string, string>} env - The complete environment for the body.
 * @param {() => Promise<unknown>} body
 */
export function withProcessEnvironment(env, body) {
  const run = pending.then(async () => {
    const saved = { ...process.env };
    try {
      restoreEnvironment({ ...env });
      return await body();
    } finally {
      restoreEnvironment(saved);
    }
  });
  pending = run.then(() => undefined, () => undefined);
  return run;
}
