/** Per-language affected-test rows: the command that runs only what a change touches, and the unit selection picks by [C7]. */

/** A file-unit row: the prefix runs each selected test file. */
const FILE = command => ({ affectedTests: command, selectionUnit: 'file' });

/** The rows, by language. {units} is every selected unit in one command; {unit} repeats the command once per unit. */
const ROWS = {
  python: FILE('pytest'),
  node: FILE('node --test'),
  go: { affectedTests: 'go test {units}', selectionUnit: 'package' },
  rust: { affectedTests: 'cargo test --manifest-path {unit}/Cargo.toml', selectionUnit: 'crate' },
  csharp: { affectedTests: 'dotnet test {unit}', selectionUnit: 'project' },
  php: FILE('vendor/bin/phpunit'),
  ruby: FILE('bundle exec rspec'),
  deno: FILE('deno test'),
  bun: FILE('bun test'),
};

/** Languages whose tests no file or unit command can narrow; they run the full gate or declare affectedSuites. */
const NONE = {
  cmake: 'AFFECTED_NONE: cmake selects by test binary; run the full gate or declare affectedSuites',
  make: 'AFFECTED_NONE: make selects by test binary; run the full gate or declare affectedSuites',
  maven: 'AFFECTED_NONE: maven has no per-file test command; run the full gate or declare affectedSuites',
  gradle: 'AFFECTED_NONE: gradle has no per-file test command; run the full gate or declare affectedSuites',
  swift: 'AFFECTED_NONE: swift has no per-file test command; run the full gate or declare affectedSuites',
};

/**
 * The affected-test row for a language: {affectedTests, selectionUnit, reason: null}, or a null command with a reason, never a guessed command [C7].
 *
 * @param {string} language a language row id such as python, go or rust
 * @returns {{affectedTests: string | null, selectionUnit: string | null, reason: string | null}}
 */
export function affectedRow(language) {
  const row = ROWS[language];
  if (row) return { ...row, reason: null };
  return { affectedTests: null, selectionUnit: null, reason: NONE[language] ?? `AFFECTED_UNKNOWN: ${String(language)} has no affected-test row; run the full gate or declare affectedSuites` };
}

/** Every language that has a row or an explicit no-row answer. */
export const AFFECTED_LANGUAGES = [...Object.keys(ROWS), ...Object.keys(NONE)];
