/** Adapter table: how a JUnit case maps to a repo file, one row per language, specifics only in the rows [C7]. */

/** Language to a function from a case row ({ classname, file }) to a repo-relative path, or null when it cannot say. */
export const JUNIT_FILE_ROWS = {
  // pytest writes a dotted module in classname (tests.test_math) and no file attribute.
  python: row => (row.classname ? `${row.classname.replace(/\./gu, '/')}.py` : null),
  // gradle test writes a dotted class in classname (com.example.CalcTest) and no file attribute; Kotlin sources sit under src/test/kotlin.
  kotlin: row => (row.classname ? `src/test/kotlin/${row.classname.replace(/\./gu, '/')}.kt` : null),
};

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
