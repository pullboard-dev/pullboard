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
  // mix test with junit_formatter writes the module in classname (Elixir.MathTest) and no file attribute; MathTest maps to test/math_test.exs.
  elixir: row => {
    const name = (row.classname ?? '').replace(/^Elixir\./u, '').split('.').pop();
    return name ? `test/${name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()}.exs` : null;
  },
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
