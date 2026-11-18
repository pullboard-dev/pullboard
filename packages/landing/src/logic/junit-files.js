/** Adapter table: how a JUnit case maps to a repo file, one row per language, specifics only in the rows [C7]. */

import { LANGUAGES } from '../../../gate/light.js';

/** Language to a function from a case row ({ classname, file }) to a repo-relative path, or null when it cannot say. */
export const JUNIT_FILE_ROWS = Object.fromEntries(LANGUAGES.filter(row => row.cases).map(row => [row.cases.name, row.cases.file]));

/**
 * The repo file a failing case belongs to: the report's own file when it names one inside root, else the language row's
 * mapping of classname. Why: reports differ by language, and landing names the file a person must open, so the table
 * holds each language's rule and nothing else does [C7].
 */
export function junitFile(language, row) {
  if (row.file) return row.file;
  const map = Object.hasOwn(JUNIT_FILE_ROWS, language) ? JUNIT_FILE_ROWS[language] : null;
  return map ? map(row) : null;
}
