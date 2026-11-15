/**
 * `pullboard test --no-file-limit`: let slow test files run to completion instead of dying at the 3-minute per-file
 * kill, so a slow file is told apart from a red one by its recorded seconds [C7].
 *
 * It lifts the budget kill and the budget placement check, up to the hard stop an audit file has; the wall limit rises
 * to the same stop, and idle-hang detection is untouched. Only test and census jobs carry it: a gate or landing job is
 * built elsewhere and never reads the field.
 */

/** The most a no-limit file may run: the hard stop an audit row has, so no file is ever without a bound. */
export const NO_FILE_LIMIT_MS = 600_000;

/**
 * The environment a runner adds to a test job's command from the job's `fileBudgetMs` field; empty when the field is
 * absent or not a whole number of milliseconds up to the hard stop. Why self-contained: a pulled job's entry embeds
 * this function's source, so it cannot reach anything else here.
 *
 * @param {{ fileBudgetMs?: unknown } | null | undefined} input - The job's input.
 * @returns {Record<string, string>}
 */
export function fileLimitEnv(input) {
  const ms = input?.fileBudgetMs;
  if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 600000) return {};
  return { PULLBOARD_TEST_FILE_BUDGET_MS: String(ms), PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS: String(ms), PULLBOARD_TEST_NO_FILE_LIMIT: '1' };
}

/** The job field the flag sets: the hard stop in milliseconds, or nothing, so a job without the flag is byte-for-byte what it was. */
export const fileBudgetField = values => (values?.['no-file-limit'] === true ? { fileBudgetMs: NO_FILE_LIMIT_MS } : {});

/**
 * Run `work` with the file limit lifted for this process when the flag is set, and restore the environment after.
 * Why: a run on this machine reads its limits from the environment its files inherit.
 *
 * @template T
 * @param {Record<string, any>} values - The parsed switches.
 * @param {() => Promise<T>} work
 * @returns {Promise<T>}
 */
export async function withFileLimit(values, work) {
  const lift = fileLimitEnv(fileBudgetField(values));
  const saved = Object.keys(lift).map(name => [name, process.env[name]]);
  Object.assign(process.env, lift);
  try { return await work(); } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
}
