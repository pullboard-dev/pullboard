/** Marker rows for further ecosystems: each language is one row of data, not more detection code [#3707,C7]. */

/** The default `npm init` test script, which is not a real test. */
const NPM_DEFAULT_TEST = 'echo "Error: no test specified" && exit 1';

/**
 * The gradle command: the wrapper when the root holds a gradlew entry, else the installed gradle.
 *
 * @param {string[]} names directory entry names of the repo root
 * @returns {string}
 */
function gradleCommand(names) {
  return names.includes('gradlew') ? './gradlew test' : 'gradle test';
}

/**
 * The bun command, or '' when a package.json already holds a real test script: the node row's 'npm test' runs that, so bun adds no second entry.
 *
 * @param {string[]} names directory entry names of the repo root
 * @param {(name: string) => string | null} contents reads one root file, null when absent
 * @returns {string}
 */
function bunCommand(names, contents) {
  if (!names.includes('package.json')) return 'bun test';
  try {
    const test = JSON.parse(contents('package.json') ?? '')?.scripts?.test;
    if (typeof test === 'string' && test.trim() && test.trim() !== NPM_DEFAULT_TEST) return '';
  } catch { /* An unreadable package does not hide bun. */ }
  return 'bun test';
}

/** The Node built-in runner writing a JUnit report to the given path; kept in this adapter so core code names no runtime [C7]. */
export function nodeJunitCommand(report) {
  return `node --test --test-reporter=junit --test-reporter-destination=${report}`;
}

/** The three JVM test-file globs, shared by the maven and gradle rows. */
const JVM_TESTS = ['**/*Test.java', '**/*Tests.java', '**/*Test.kt'];

/** The extra ecosystem rows, in detection order; starts empty so behaviour is unchanged until a row is added. */
export const LANGUAGE_ROWS = Object.freeze([
  { language: 'bun', markers: ['bun.lock', 'bun.lockb', 'bunfig.toml'], command: bunCommand, tests: ['**/*.test.ts', '**/*.test.js', '**/*.spec.ts'] },
  { language: 'deno', markers: ['deno.json', 'deno.jsonc'], command: 'deno test', tests: ['**/*_test.ts', '**/*.test.ts', '**/*_test.js'] },
  { language: 'gradle', markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], command: gradleCommand, tests: JVM_TESTS },
  { language: 'haskell', markers: ['stack.yaml', 'cabal.project'], pattern: /\.cabal$/u, command: (names) => (names.includes('stack.yaml') ? 'stack test' : 'cabal test'), tests: ['**/test/**/*.hs', '**/*Spec.hs'] },
  { language: 'maven', markers: ['pom.xml'], command: 'mvn test', tests: JVM_TESTS },
  { language: 'perl', markers: ['cpanfile', 'Makefile.PL', 'Build.PL', 'dist.ini'], command: (names) => (names.includes('t') ? 'prove -lr t' : ''), tests: ['t/**/*.t'] },
  { language: 'sbt', markers: ['build.sbt'], command: 'sbt test', tests: ['**/src/test/scala/**/*.scala'] },
]);

/**
 * Whether one row's ecosystem is present in a repo root, judged only from names and file contents.
 * Why: a table of simple rows lets each language land as one row and one test, with no new detection code.
 *
 * @param {{ markers?: string[], pattern?: RegExp, requires?: { file: string, includes: string }, command?: string | ((names: string[], contents: (name: string) => string | null) => string) }} row
 * @param {string[]} names directory entry names of the repo root
 * @param {(name: string) => string | null} contents reads one root file, null when absent
 * @returns {boolean}
 */
export function rowMatches(row, names, contents) {
  const hit = (row.markers ?? []).some((marker) => names.includes(marker))
    || (row.pattern instanceof RegExp && names.some((name) => new RegExp(row.pattern.source, row.pattern.flags.replace(/[gy]/gu, '')).test(name)));
  if (!hit) return false;
  if (typeof row.command === 'function' && !row.command(names, contents)) return false;
  if (!row.requires) return true;
  return contents(row.requires.file)?.includes(row.requires.includes) ?? false;
}
