/** Adapter table: how a JUnit case maps to a repo file, one row per language, specifics only in the rows [C7]. */

/** Language to a function from a case row ({ classname, file }) to a repo-relative path, or null when it cannot say. */
export const JUNIT_FILE_ROWS = {
  // pytest writes a dotted module in classname (tests.test_math) and no file attribute.
  python: row => (row.classname ? `${row.classname.replace(/\./gu, '/')}.py` : null),
  // dart test with junitreport writes the test file path (test/calc_test.dart) in classname and no file attribute.
  dart: row => (row.classname && /\.dart$/u.test(row.classname) ? row.classname : null),
  // bun test writes the test file as the top-level classname (calc.test.ts) and no file attribute on the case.
  bun: row => row.classname || null,
  // Surefire writes a dotted class in classname (com.example.CalcTest), no file attribute; Maven's source layout holds the test.
  java: row => (row.classname ? `src/test/java/${row.classname.split('$')[0].replace(/\./gu, '/')}.java` : null),
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
  // ctest --output-junit writes the test name as classname and no file attribute; the name is the test binary selection unit. C uses this row.
  cpp: row => row.classname || null,
  // sbt test writes the dotted class (com.example.CalcSpec) in classname and no file attribute.
  sbt: row => (row.classname ? `src/test/scala/${row.classname.replace(/\./gu, '/')}.scala` : null),
  // node --test --test-reporter=junit writes file (absolute, inside the checkout) on every case, which junitFile already prefers; the row only answers a case the reporter left without one.
  node: row => row.file || null,
  // swift test --xunit-output writes classname Module.Class and no file attribute; SwiftPM keeps tests in Tests/<Module>/<Class>.swift.
  swift: row => {
    const [module, cls] = (row.classname || '').split('.');
    return module && cls ? `Tests/${module}/${cls}.swift` : null;
  },
  // gotestsum writes the import path (example.com/m/pkg) in classname and no file attribute; the first two segments are
  // the module (host and name), the rest is the package directory.
  go: row => {
    const dir = (row.classname ?? '').split('/').slice(2).join('/');
    return dir ? `${dir}/` : null;
  },
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
