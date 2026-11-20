/** Adapter table: how a JUnit case maps to a repo file, one row per language, specifics only in the rows [C7]. */

import { LANGUAGES } from '../../../gate/light.js';

/** Language to a function from a case row ({ classname, file }) to a repo-relative path, or null when it cannot say. */
export const JUNIT_FILE_ROWS = Object.fromEntries(LANGUAGES.filter(row => row.cases).map(row => [row.cases.name, row.cases.file]));

/**
 * The repo file a failing case belongs to: the report's own file when it names one inside root, else the language row's
 * mapping of classname, found by the report name or by the language name detectLanguages returns (cmake reports as cpp). Why: reports differ by language, and landing names the file a person must open, so the table
 * holds each language's rule and nothing else does [C7].
 */
export function junitFile(language, row) {
  if (row.file) return row.file;
  // A gradle report cannot say Java or Kotlin: the kotlin row's path when row.kotlin is true, else the java row's path, both read from the rows above, never a second table.
  if (language === 'gradle') return (row.kotlin === true ? JUNIT_FILE_ROWS.kotlin : JUNIT_FILE_ROWS.java)(row);
  const named = Object.hasOwn(JUNIT_FILE_ROWS, language) ? JUNIT_FILE_ROWS[language] : null;
  const map = named ?? LANGUAGES.find(candidate => candidate.language === language)?.cases?.file ?? null;
  return map ? map(row) : null;
}
