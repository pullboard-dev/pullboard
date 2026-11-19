/** Doctor's Jest finding: a Jest project that scans the seat worktrees under .claude/worktrees [C7]. */

/** The ignore entry doctor names; Pullboard puts seat worktrees under .claude/worktrees (#664). */
export const JEST_WORKTREE_IGNORE = '<rootDir>/.claude/worktrees/';

/** An ignore list, in either ignore key, holding a path that covers the seat worktrees folder. */
const COVERED = /(?:testPathIgnorePatterns|modulePathIgnorePatterns)['"]?\s*:\s*\[[^\]]*\.claude[\\/]+worktrees/u;

/** Whether the package's test script runs jest. */
function runsJest(packageText) {
  let data;
  try { data = JSON.parse(packageText); } catch { return false; }
  const script = data?.scripts?.test;
  return typeof script === 'string' && /(?:^|[\s;&|(])jest(?:$|[\s;&|)])/u.test(script);
}

/**
 * One problem when the project's test script runs jest and its Jest config does not ignore the seat worktrees folder,
 * else null. Pure: doctor reads package.json and the Jest config file and passes their text.
 * Why: on a Jest project with the default testMatch, npm test at the main checkout also scanned the test copies in the
 * seat worktrees and reported hundreds of failed suites. Doctor names the entry to add; it never edits the project's config.
 *
 * @param {string | undefined} packageText the text of package.json
 * @param {string | undefined} configText the text of the Jest config file, or of the package's jest key when the config lives there
 * @returns {{ code: string, message: string, next: string } | null}
 */
export function jestWorktreeProblem(packageText, configText) {
  if (!packageText || !runsJest(packageText)) return null;
  if (COVERED.test(configText ?? '')) return null;
  return {
    code: 'JEST_SCANS_WORKTREES',
    message: 'the Jest config does not ignore the seat worktrees under .claude/worktrees, so npm test also runs their copies of the tests',
    next: `add "${JEST_WORKTREE_IGNORE}" to testPathIgnorePatterns in the Jest config`,
  };
}
