/**
 * The browser and GUI needs a shipped plan hands a shard run [C7].
 * Why: each shard started a fresh node that read every test file's declaration again, 17 s of selection a shard, when the plan already knows both answers.
 */

/** The environment variable that carries the plan: JSON `{"browser": boolean, "gui": boolean}`. */
export const SHARD_PLAN_ENV = 'PULLBOARD_SHARD_PLAN';

/**
 * Read the shard plan from an environment.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ browser: boolean, gui: boolean } | null} The plan, or null when the variable is unset or not a plan, so the caller computes both as before.
 */
export function shardPlan(env) {
  const raw = env[SHARD_PLAN_ENV];
  if (typeof raw !== 'string' || raw === '') return null;
  let plan;
  try { plan = JSON.parse(raw); } catch { return null; }
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) return null;
  if (typeof plan.browser !== 'boolean' || typeof plan.gui !== 'boolean') return null;
  return { browser: plan.browser, gui: plan.gui };
}
