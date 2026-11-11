/** A commit may add a root test/ file only as a journey the test-cell listing names with its reason [C7]. */

/** The listing that names root journeys and their reasons (#3857). */
export const TEST_CELLS_LISTING = 'packages/gate/data/tests/test-cells.json';

/**
 * The root test files a commit adds that the listing does not name as journeys. A path already on HEAD or on main is not
 * added by this commit, so a merge of main brings no refusal. Why: a new test under test/ belongs in its cell's tests/
 * folder, and an unlisted one breaks the cell seal the test-cell ratchet keeps (#4005).
 *
 * @param {string[]} written - The staged paths the commit writes.
 * @param {{ known: (path: string) => boolean, listing: () => string | null, isTest: (path: string) => boolean }} reads - `isTest`
 *   names a test file by the project's configured test-file patterns; `known` is true for a path on HEAD
 *   or main; `listing` is the staged listing text, or null when the index has none (the rule is then off).
 * @returns {string[]} The unlisted new root test files, sorted.
 */
export function unlistedRootTests(written, { known, listing, isTest }) {
  const added = written.filter(path => path.startsWith('test/') && isTest(path) && !known(path));
  if (!added.length) return [];
  // A repository without the listing has not adopted test cells, so the rule is off there.
  const text = listing();
  if (text === null) return [];
  let journeys = {};
  try { journeys = JSON.parse(text)?.journeys ?? {}; } catch { journeys = {}; } // An unreadable listing names no journey.
  return added.filter(path => !(typeof journeys[path] === 'string' && journeys[path].trim())).sort();
}

/**
 * The refusal for unlisted new root tests, as rule code, message and next step, or null when there are none.
 *
 * @param {string[]} files
 * @returns {{ code: string, message: string, next: string } | null}
 */
export function unlistedRootTestRefusal(files) {
  if (!files.length) return null;
  return { code: 'ROOT_TEST_UNLISTED',
    message: `${files.join(', ')} ${files.length === 1 ? 'is a new root test' : 'are new root tests'} that ${TEST_CELLS_LISTING} does not list as a journey`,
    next: `move ${files.length === 1 ? 'it' : 'each'} into its cell's tests folder (packages/<cell>/tests/ or apps/<cell>/tests/), or list it under "journeys" in ${TEST_CELLS_LISTING} with its reason, then commit again` };
}

/**
 * The refusal a commit's staged paths earn by adding unlisted root tests, or null. `read(path)` is the staged text of a
 * path, or null when the index has none.
 *
 * @param {string[]} written
 * @param {{ known: (path: string) => boolean, read: (path: string) => string | null, isTest: (path: string) => boolean }} reads
 */
export function rootTestRefusal(written, { known, read, isTest }) {
  return unlistedRootTestRefusal(unlistedRootTests(written, { known, isTest, listing: () => read(TEST_CELLS_LISTING) }));
}
