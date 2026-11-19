/** Whole-file limits bound active work separately from post-test cleanup [C7,V10]. */
import { environmentAdapter } from '../../../env/index.js';
export const DEFAULT_FILE_WALL_MS = 300_000;
export const DEFAULT_FILE_IDLE_MS = 90_000;
/** The policy's per-file budget (2-3 minutes): a file past it is killed whatever its load factor or case budgets. */
export const DEFAULT_FILE_BUDGET_MS = 180_000;

/** Reject malformed limits before executing a file rather than silently disabling supervision. */
function limit(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer no greater than 2147483647 milliseconds`);
  }
  return Number(value);
}

/**
 * The wall-limit multiplier for a machine's load: load per core, never below 1x and never above 4x.
 * Why: a saturated runner makes a passing file slow, and a fixed wall turned that slowness into a red.
 */
export function wallLoadFactor(load, cores) {
  const perCore = Number(load) / Math.max(1, Number(cores));
  return Number.isFinite(perCore) ? Math.min(4, Math.max(1, perCore)) : 1;
}

/**
 * An exact per-file or environment limit wins as written; only the default wall scales with `system` load
 * ({ load, cores }, sampled once at file start). Idle detection remains independent.
 */
export function fileWatchdogLimits(file, env = environmentAdapter().all(), system = { load: 0, cores: 1 }) {
  let files = {};
  if (env.PULLBOARD_TEST_FILE_LIMITS !== undefined) {
    files = JSON.parse(env.PULLBOARD_TEST_FILE_LIMITS);
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('PULLBOARD_TEST_FILE_LIMITS must be a JSON object of file paths to milliseconds');
    for (const [path, value] of Object.entries(files)) limit(value, DEFAULT_FILE_WALL_MS, `PULLBOARD_TEST_FILE_LIMITS[${path}]`);
  }
  const explicit = files[file] ?? env.PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS;
  const loadFactor = explicit === undefined ? wallLoadFactor(system.load, system.cores) : 1;
  const baseWallMs = limit(explicit, DEFAULT_FILE_WALL_MS, 'PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS');
  // An exact per-file limit above the default is that file's declared opt-out; the budget never cuts it short.
  const budgetMs = Math.max(limit(env.PULLBOARD_TEST_FILE_BUDGET_MS, DEFAULT_FILE_BUDGET_MS, 'PULLBOARD_TEST_FILE_BUDGET_MS'),
    files[file] !== undefined && env.PULLBOARD_TEST_FILE_BUDGET_MS === undefined ? Number(files[file]) : 0,
    // The file's budget row (set by the dispatcher) is its declared budget: the kill never undercuts it, unless the budget was set explicitly, which wins as written.
    env.PULLBOARD_TEST_FILE_ROW_BUDGET_MS === undefined || env.PULLBOARD_TEST_FILE_BUDGET_MS !== undefined ? 0 : limit(env.PULLBOARD_TEST_FILE_ROW_BUDGET_MS, 0, 'PULLBOARD_TEST_FILE_ROW_BUDGET_MS'));
  return { wallMs: Math.round(baseWallMs * loadFactor), baseWallMs, loadFactor, budgetMs,
    idleMs: limit(env.PULLBOARD_TEST_IDLE_TIMEOUT_MS, DEFAULT_FILE_IDLE_MS, 'PULLBOARD_TEST_IDLE_TIMEOUT_MS') };
}

/** A quiet window is hung only below one percent of one CPU; equality stays active. */
export function fileIdleHung({ quietMs, cpuMicros }, idleMs) {
  return quietMs >= idleMs && cpuMicros < quietMs * 10;
}

/** How many test workers a pulled job may use: its share of the runner's cores, set by the serve that runs it [P7,#5919]. */
export const JOB_WORKERS_ENV = 'PULLBOARD_JOB_WORKERS';
