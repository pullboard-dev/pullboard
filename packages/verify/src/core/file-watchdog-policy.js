/** Whole-file limits bound active work separately from post-test cleanup [C7,V10]. */
export const DEFAULT_FILE_WALL_MS = 300_000;
export const DEFAULT_FILE_IDLE_MS = 90_000;

/** Reject malformed limits before executing a file rather than silently disabling supervision. */
function limit(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/u.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer no greater than 2147483647 milliseconds`);
  }
  return Number(value);
}

/** An exact per-file override wins over the global wall limit; idle detection remains independent. */
export function fileWatchdogLimits(file, env = process.env) {
  let files = {};
  if (env.PULLBOARD_TEST_FILE_LIMITS !== undefined) {
    files = JSON.parse(env.PULLBOARD_TEST_FILE_LIMITS);
    if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('PULLBOARD_TEST_FILE_LIMITS must be a JSON object of file paths to milliseconds');
    for (const [path, value] of Object.entries(files)) limit(value, DEFAULT_FILE_WALL_MS, `PULLBOARD_TEST_FILE_LIMITS[${path}]`);
  }
  return { wallMs: limit(files[file] ?? env.PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS, DEFAULT_FILE_WALL_MS, 'PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS'),
    idleMs: limit(env.PULLBOARD_TEST_IDLE_TIMEOUT_MS, DEFAULT_FILE_IDLE_MS, 'PULLBOARD_TEST_IDLE_TIMEOUT_MS') };
}

/** A quiet window is hung only below one percent of one CPU; equality stays active. */
export function fileIdleHung({ quietMs, cpuMicros }, idleMs) {
  return quietMs >= idleMs && cpuMicros < quietMs * 10;
}
