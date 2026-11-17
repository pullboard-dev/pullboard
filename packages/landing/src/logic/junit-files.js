/** Adapter table: how a JUnit case maps to a repo file, one row per language, specifics only in the rows [C7]. */

/** Language to a function from a case row ({ classname, file }) to a repo-relative path, or null when it cannot say. */
export const JUNIT_FILE_ROWS = {
  // pytest writes a dotted module in classname (tests.test_math) and no file attribute.
  python: row => (row.classname ? `${row.classname.replace(/\./gu, '/')}.py` : null),
  // cargo nextest writes the crate in classname (mycrate, or mycrate::bin/mycrate for a binary) and no file attribute.
  rust: row => {
    const crate = (row.classname ?? '').split('::')[0];
    return crate ? `${crate}/` : null;
  },
  // ctest --output-junit writes the test name as classname and no file attribute; the name is the test binary selection unit. C uses this row.
  cpp: row => row.classname || null,
  // sbt test writes the dotted class (com.example.CalcSpec) in classname and no file attribute.
  sbt: row => (row.classname ? `src/test/scala/${row.classname.replace(/\./gu, '/')}.scala` : null),
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
