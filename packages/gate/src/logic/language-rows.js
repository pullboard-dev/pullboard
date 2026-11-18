/** Marker rows for further ecosystems: each language is one row of data, not more detection code [#3707,C7]. */

/** Whether a pubspec.yaml declares a Flutter project: a line that is exactly `flutter:` (a key, not `sdk: flutter` or `flutter_test:`). */
const FLUTTER_LINE = /^[ \t]*flutter:[ \t]*$/mu;

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

/**
 * Ruby: a Gemfile alone proves nothing, so the command reads what the repo holds and answers '' (no match) when it holds neither a spec nor a Rake test setup.
 *
 * @param {string[]} names directory entry names of the repo root
 * @returns {string}
 */
function rubyCommand(names) {
  if (names.includes('.rspec') || names.includes('spec')) return 'bundle exec rspec';
  if (names.includes('Rakefile') && names.includes('test')) return 'bundle exec rake test';
  return '';
}

/** The Node built-in runner writing a JUnit report to the given path; kept in this adapter so core code names no runtime [C7]. */
export function nodeJunitCommand(report) {
  return `node --test --test-reporter=junit --test-reporter-destination=${report}`;
}

/** The Julia gate command, or '' when the project holds no test/runtests.jl: Project.toml alone is a package, not a tested one. */
function juliaCommand(names, contents) {
  return contents('test/runtests.jl') === null ? '' : "julia --project -e 'using Pkg; Pkg.test()'";
}

/** The three JVM test-file globs, shared by the maven and gradle rows. */
const JVM_TESTS = ['**/*Test.java', '**/*Tests.java', '**/*Test.kt'];

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

/*
 * LANGUAGES: one row per language, the single table the gate and landing read every per-language fact from [C7].
 * Adding a language is one row here plus one test (packages/gate/tests/logic/language-rows.test.js checks it is complete);
 * no other file holds a per-language table. The old tables (LANGUAGE_ROWS, the toolchain and JUnit rows, the affected rows,
 * landing's JUNIT_FILE_ROWS) are views of this one. A row:
 *   language   the id detectLanguages returns
 *   detect     { markers?, pattern?, requires?, command } matched by rowMatches in table order; 'built-in' when
 *              detectHere finds it in code; null when nothing detects it
 *   tests      the test-file globs detectTestGlobs adds, or a function of the folder's entry names
 *   toolchains the runner toolchains, or a function of the detected command; null when no row exists
 *   junit      { command, report, needs }: the JUnit-writing gate command, its report path and the init note; null when none
 *   affected   { affectedTests, selectionUnit } or { none: reason }; null when no row exists
 *   cases      { name, inputs, file }: the report name, the extra row fields file reads (inputs, deno: root), and the
 *              case to repo-file map; null when none
 * Every row runs an open-source toolchain locally and reads an open report format (JUnit XML, exit codes).
 */

/** The folder each single-file JUnit report goes in (the DIR of ./junit.js). */
const JUNIT_DIR = '.pullboard/junit';

/** A file-unit affected row: the prefix runs each selected test file. */
const fileUnit = command => ({ affectedTests: command, selectionUnit: 'file' });

/** Every language, built-in detection first in detectHere order, then the LANGUAGE_ROWS order, make, and the undetected. */
export const LANGUAGES = Object.freeze([
  {
    language: 'node',
    detect: 'built-in',
    tests: [],
    toolchains: ['node'],
    junit: { command: nodeJunitCommand(`${JUNIT_DIR}/node.xml`), report: `${JUNIT_DIR}/node.xml`, needs: null },
    affected: fileUnit('node --test'),
    // node --test --test-reporter=junit writes file (absolute, inside the checkout) on every case, which junitFile already prefers; the row only answers a case the reporter left without one.
    cases: { name: 'node', inputs: [], file: row => row.file || null },
  },
  {
    language: 'go',
    detect: 'built-in',
    tests: ['**/*_test.go'],
    toolchains: ['go'],
    junit: { command: `gotestsum --junitfile ${JUNIT_DIR}/go.xml -- ./...`, report: `${JUNIT_DIR}/go.xml`, needs: 'gotestsum (go install gotest.tools/gotestsum@latest)' },
    affected: { affectedTests: 'go test {units}', selectionUnit: 'package' },
    // gotestsum writes the import path (example.com/m/pkg) in classname and no file attribute; the first two segments are
    // the module (host and name), the rest is the package directory.
    cases: { name: 'go', inputs: [], file: row => {
      const dir = (row.classname ?? '').split('/').slice(2).join('/');
      return dir ? `${dir}/` : null;
    } },
  },
  {
    language: 'rust',
    detect: 'built-in',
    tests: ['**/tests/*.rs'],
    toolchains: ['cargo'],
    junit: { command: 'cargo nextest run --profile ci', report: 'target/nextest/ci/junit.xml', needs: 'cargo-nextest and a [profile.ci.junit] path = "junit.xml" entry in .config/nextest.toml' },
    affected: { affectedTests: 'cargo test --manifest-path {unit}/Cargo.toml', selectionUnit: 'crate' },
    // cargo nextest writes the crate in classname (mycrate, or mycrate::bin/mycrate for a binary) and no file attribute.
    cases: { name: 'rust', inputs: [], file: row => {
      const crate = (row.classname ?? '').split('::')[0];
      return crate ? `${crate}/` : null;
    } },
  },
  {
    language: 'python',
    detect: 'built-in',
    tests: ['**/test_*.py', '**/*_test.py'],
    toolchains: command => [...(/^\s*uv\s/u.test(command) ? ['uv'] : /^\s*poetry\s/u.test(command) ? ['poetry'] : []), 'python3'],
    junit: { command: `pytest --junitxml=${JUNIT_DIR}/python.xml`, report: `${JUNIT_DIR}/python.xml`, needs: null },
    affected: fileUnit('pytest'),
    // pytest writes a dotted module in classname (tests.test_math) and no file attribute.
    cases: { name: 'python', inputs: [], file: row => (row.classname ? `${row.classname.replace(/\./gu, '/')}.py` : null) },
  },
  {
    language: 'php',
    detect: 'built-in',
    tests: ['**/*Test.php'],
    toolchains: command => (/^\s*composer\s/u.test(command) ? ['composer', 'php'] : ['php']),
    junit: { command: `vendor/bin/phpunit --log-junit ${JUNIT_DIR}/php.xml`, report: `${JUNIT_DIR}/php.xml`, needs: null },
    affected: fileUnit('vendor/bin/phpunit'),
    // phpunit writes the file attribute (absolute, inside the checkout); when it is absent the class name (Tests\MathTest or Tests.MathTest) maps to tests/MathTest.php.
    cases: { name: 'php', inputs: [], file: row => {
      const name = (row.classname ?? '').split(/[\\.]/u).pop();
      return name ? `tests/${name}.php` : null;
    } },
  },
  {
    language: 'elixir',
    detect: 'built-in',
    tests: ['**/*_test.exs'],
    toolchains: ['mix'],
    junit: { command: 'mix test', report: `${JUNIT_DIR}/elixir.xml`, needs: `the junit_formatter dependency as an ExUnit formatter, with report_dir "${JUNIT_DIR}" and report_file "elixir.xml"` },
    affected: null,
    // mix test with junit_formatter writes the module in classname (Elixir.MathTest) and no file attribute; MathTest maps to test/math_test.exs.
    cases: { name: 'elixir', inputs: [], file: row => {
      const name = (row.classname ?? '').replace(/^Elixir\./u, '').split('.').pop();
      return name ? `test/${name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toLowerCase()}.exs` : null;
    } },
  },
  {
    language: 'csharp',
    detect: 'built-in',
    tests: ['**/*Tests.cs', '**/*Test.cs'],
    toolchains: ['dotnet'],
    junit: { command: `dotnet test --logger "junit;LogFilePath=$PWD/${JUNIT_DIR}/csharp.xml"`, report: `${JUNIT_DIR}/csharp.xml`, needs: 'the JunitXml.TestLogger package in each test project' },
    affected: { affectedTests: 'dotnet test {unit}', selectionUnit: 'project' },
    // dotnet test (JunitXml.TestLogger) writes namespace.Class in classname and no file attribute; the first segment names the test project directory.
    cases: { name: 'csharp', inputs: [], file: row => {
      const project = (row.classname ?? '').split('.')[0];
      return project ? `${project}/` : null;
    } },
  },
  {
    language: 'cmake',
    detect: 'built-in',
    tests: ['**/*_test.c', '**/*_test.cpp', '**/test_*.c', '**/test_*.cpp'],
    toolchains: ['cmake', 'ctest'],
    junit: { command: `cmake -S . -B build && cmake --build build && ctest --test-dir build --output-junit ../${JUNIT_DIR}/cmake.xml`, report: `${JUNIT_DIR}/cmake.xml`, needs: null },
    affected: { none: 'AFFECTED_NONE: cmake selects by test binary; run the full gate or declare affectedSuites' },
    // ctest --output-junit writes the test name as classname and no file attribute; the name is the test binary selection unit. C uses this row.
    cases: { name: 'cpp', inputs: [], file: row => row.classname || null },
  },
  {
    language: 'bun',
    detect: { markers: ['bun.lock', 'bun.lockb', 'bunfig.toml'], command: bunCommand },
    tests: ['**/*.test.ts', '**/*.test.js', '**/*.spec.ts'],
    toolchains: ['bun'],
    junit: { command: `bun test --reporter=junit --reporter-outfile=${JUNIT_DIR}/bun.xml`, report: `${JUNIT_DIR}/bun.xml`, needs: null },
    affected: fileUnit('bun test'),
    // bun test writes the test file as the top-level classname (calc.test.ts) and no file attribute on the case.
    cases: { name: 'bun', inputs: [], file: row => row.classname || null },
  },
  {
    language: 'clojure',
    detect: { markers: ['project.clj', 'deps.edn'], command: (names) => (names.includes('project.clj') ? 'lein test' : 'clojure -M:test') },
    tests: ['test/**/*.clj', '**/*_test.clj'],
    toolchains: command => (/^\s*lein\s/u.test(command) ? ['lein'] : ['clojure']),
    junit: { command: `clojure -M:test --plugin kaocha.plugin/junit-xml --junit-xml-file ${JUNIT_DIR}/clojure.xml`, report: `${JUNIT_DIR}/clojure.xml`, needs: 'the kaocha test runner under a :test alias in deps.edn' },
    affected: null,
    // lein test / kaocha junit writes the namespace in classname (my-app.core-test) and no file attribute; dots are folders and hyphens are underscores under test/.
    cases: { name: 'clojure', inputs: [], file: row => (row.classname ? `test/${row.classname.replace(/-/gu, '_').replace(/\./gu, '/')}.clj` : null) },
  },
  {
    language: 'deno',
    detect: { markers: ['deno.json', 'deno.jsonc'], command: 'deno test' },
    tests: ['**/*_test.ts', '**/*.test.ts', '**/*_test.js'],
    toolchains: ['deno'],
    junit: { command: `deno test --reporter=junit --junit-path=${JUNIT_DIR}/deno.xml`, report: `${JUNIT_DIR}/deno.xml`, needs: null },
    affected: fileUnit('deno test'),
    // deno test --junit-path writes the test file as a file:// URL in classname and no file attribute; the checkout root (row.root when given) is removed, and an absolute path outside it stays null (never guess).
    cases: { name: 'deno', inputs: ['root'], file: row => {
      const path = (row.classname ?? '').replace(/^file:\/\//u, '');
      if (!path) return null;
      if (!path.startsWith('/')) return path;
      return row.root && path.startsWith(`${row.root.replace(/\/$/u, '')}/`) ? path.slice(row.root.replace(/\/$/u, '').length + 1) : null;
    } },
  },
  {
    language: 'crystal',
    detect: { markers: ['shard.yml'], command: 'crystal spec' },
    tests: ['spec/**/*_spec.cr', '**/spec/**/*_spec.cr'],
    toolchains: ['crystal'],
    junit: { command: `crystal spec --junit_output ${JUNIT_DIR}/crystal.xml`, report: `${JUNIT_DIR}/crystal.xml`, needs: null },
    affected: null,
    // crystal spec --junit writes the spec file path (spec/calc_spec.cr) in classname and no file attribute on the case.
    cases: { name: 'crystal', inputs: [], file: row => (row.classname && /\.cr$/u.test(row.classname) ? row.classname : null) },
  },
  {
    language: 'gradle',
    detect: { markers: ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'], command: gradleCommand },
    tests: JVM_TESTS,
    toolchains: command => (/^\s*gradle\s/u.test(command) ? ['gradle', 'java'] : ['java']),
    junit: { command: './gradlew test', report: 'build/test-results/test', needs: null },
    affected: { none: 'AFFECTED_NONE: gradle has no per-file test command; run the full gate or declare affectedSuites' },
    // gradle test writes a dotted class in classname (com.example.CalcTest) and no file attribute; Kotlin sources sit under src/test/kotlin.
    cases: { name: 'kotlin', inputs: [], file: row => (row.classname ? `src/test/kotlin/${row.classname.replace(/\./gu, '/')}.kt` : null) },
  },
  {
    language: 'haskell',
    detect: { markers: ['stack.yaml', 'cabal.project'], pattern: /\.cabal$/u, command: (names) => (names.includes('stack.yaml') ? 'stack test' : 'cabal test') },
    tests: ['**/test/**/*.hs', '**/*Spec.hs'],
    toolchains: command => (/^\s*stack\s/u.test(command) ? ['stack'] : ['cabal']),
    junit: { command: `JUNIT_ENABLED=1 JUNIT_OUTPUT_DIRECTORY=${JUNIT_DIR} JUNIT_OUTPUT_NAME=haskell.xml cabal test`, report: `${JUNIT_DIR}/haskell.xml`, needs: 'the hspec-junit-formatter package in the test suite, run through hspec-discover' },
    affected: null,
    // hspec-junit-formatter writes the dotted spec module (Data.CalcSpec) in classname and no file attribute; a module ending in Spec is the spec file's own path (Data/CalcSpec.hs), a bare group (Calc) is test/CalcSpec.hs.
    cases: { name: 'haskell', inputs: [], file: row => (row.classname ? (/Spec$/u.test(row.classname) ? `${row.classname.replace(/\./gu, '/')}.hs` : `test/${row.classname.replace(/\./gu, '/')}Spec.hs`) : null) },
  },
  {
    language: 'julia',
    detect: { markers: ['Project.toml'], command: juliaCommand },
    tests: ['test/**/*.jl', '**/runtests.jl'],
    toolchains: ['julia'],
    junit: { command: `julia --project -e 'using TestReports; TestReports.test(logfilename="julia.xml", logfilepath="${JUNIT_DIR}")'`, report: `${JUNIT_DIR}/julia.xml`, needs: 'the TestReports package in the project test dependencies' },
    affected: null,
    // Julia's Test suite JUnit report names the testset in classname and no file attribute; Pkg.test runs the one test/runtests.jl.
    cases: { name: 'julia', inputs: [], file: row => (row.classname ? 'test/runtests.jl' : null) },
  },
  {
    language: 'maven',
    detect: { markers: ['pom.xml'], command: 'mvn test' },
    tests: JVM_TESTS,
    toolchains: ['java', 'mvn'],
    junit: { command: 'mvn test', report: 'target/surefire-reports', needs: null },
    affected: { none: 'AFFECTED_NONE: maven has no per-file test command; run the full gate or declare affectedSuites' },
    // Surefire writes a dotted class in classname (com.example.CalcTest), no file attribute; Maven's source layout holds the test.
    cases: { name: 'java', inputs: [], file: row => (row.classname ? `src/test/java/${row.classname.split('$')[0].replace(/\./gu, '/')}.java` : null) },
  },
  {
    language: 'nim',
    detect: { pattern: /\.nimble$/u, command: 'nimble test' },
    tests: ['**/tests/**/*.nim', '**/test_*.nim'],
    toolchains: ['nimble'],
    junit: null,
    affected: null,
    // nim unittest's JUnit output names the test file module in classname (tcalc) and no file attribute; nimble keeps tests in tests/<name>.nim.
    cases: { name: 'nim', inputs: [], file: row => (row.classname ? `tests/${row.classname.replace(/\.nim$/u, '')}.nim` : null) },
  },
  {
    language: 'ocaml',
    detect: { markers: ['dune-project'], command: 'dune test' },
    tests: ['**/test/**/*.ml', '**/tests/**/*.ml', '**/*_test.ml'],
    toolchains: ['dune'],
    junit: null,
    affected: null,
    // dune test with an OCaml JUnit reporter (alcotest or ounit2 output) writes the suite name in classname (Calc) and no file attribute; dune keeps it in test/calc.ml.
    cases: { name: 'ocaml', inputs: [], file: row => (row.classname ? `test/${row.classname.toLowerCase()}.ml` : null) },
  },
  {
    language: 'perl',
    detect: { markers: ['cpanfile', 'Makefile.PL', 'Build.PL', 'dist.ini'], command: (names) => (names.includes('t') ? 'prove -lr t' : '') },
    tests: ['t/**/*.t'],
    toolchains: ['perl'],
    junit: { command: `prove -lr --formatter TAP::Formatter::JUnit t > ${JUNIT_DIR}/perl.xml`, report: `${JUNIT_DIR}/perl.xml`, needs: 'the TAP::Formatter::JUnit module (cpanm TAP::Formatter::JUnit)' },
    affected: null,
    // prove with TAP::Formatter::JUnit names the suite after the script path with separators turned to underscores (t_calc_t).
    cases: { name: 'perl', inputs: [], file: row => (row.classname ? row.classname.replace(/_t$/u, '.t').replace(/_/gu, '/') : null) },
  },
  {
    language: 'ruby',
    detect: { markers: ['Gemfile'], command: rubyCommand },
    tests: (names) => (rubyCommand(names) === 'bundle exec rspec' ? ['**/*_spec.rb'] : ['**/test_*.rb', '**/*_test.rb']),
    toolchains: command => (/^\s*bundle\s/u.test(command) ? ['bundle', 'ruby'] : /^\s*rake\s/u.test(command) ? ['rake', 'ruby'] : ['ruby']),
    junit: { command: `bundle exec rspec --format RspecJunitFormatter --out ${JUNIT_DIR}/ruby.xml`, report: `${JUNIT_DIR}/ruby.xml`, needs: 'the rspec_junit_formatter gem in the Gemfile test group' },
    affected: fileUnit('bundle exec rspec'),
    // rspec_junit_formatter writes classname as the dotted spec path (spec.calc_spec) and usually a file attribute too.
    cases: { name: 'ruby', inputs: [], file: row => (row.classname ? `${row.classname.replace(/\./gu, '/')}.rb` : null) },
  },
  {
    language: 'sbt',
    detect: { markers: ['build.sbt'], command: 'sbt test' },
    tests: ['**/src/test/scala/**/*.scala'],
    toolchains: ['java', 'sbt'],
    junit: { command: 'sbt test', report: 'target/test-reports', needs: null },
    affected: null,
    // sbt test writes the dotted class (com.example.CalcSpec) in classname and no file attribute.
    cases: { name: 'sbt', inputs: [], file: row => (row.classname ? `src/test/scala/${row.classname.replace(/\./gu, '/')}.scala` : null) },
  },
  {
    language: 'zig',
    detect: { markers: ['build.zig'], command: 'zig build test' },
    tests: ['**/*_test.zig', '**/test/**/*.zig', '**/tests/**/*.zig'],
    toolchains: ['zig'],
    junit: null,
    affected: null,
    // A Zig JUnit reporter (zig build test has no built-in one) writes the test file path (src/calc.zig) in classname and no file attribute.
    cases: { name: 'zig', inputs: [], file: row => (row.classname && /\.zig$/u.test(row.classname) ? row.classname : null) },
  },
  {
    language: 'make',
    detect: 'built-in',
    tests: [],
    toolchains: ['make'],
    junit: null,
    affected: { none: 'AFFECTED_NONE: make selects by test binary; run the full gate or declare affectedSuites' },
    cases: null,
  },
  {
    language: 'dart',
    detect: { markers: ['pubspec.yaml'], command: (_names, contents) => (FLUTTER_LINE.test(contents('pubspec.yaml') ?? '') ? 'flutter test' : 'dart test') },
    tests: ['**/*_test.dart'],
    toolchains: command => (/^\s*flutter\s/u.test(command) ? ['flutter'] : ['dart']),
    junit: null,
    affected: null,
    // dart test with junitreport writes the test file path (test/calc_test.dart) in classname and no file attribute.
    cases: { name: 'dart', inputs: [], file: row => (row.classname && /\.dart$/u.test(row.classname) ? row.classname : null) },
  },
  {
    language: 'swift',
    detect: { markers: ['Package.swift'], command: 'swift test' },
    tests: ['**/Tests/**/*Tests.swift'],
    toolchains: ['swift'],
    junit: { command: `swift test --xunit-output ${JUNIT_DIR}/swift.xml`, report: `${JUNIT_DIR}/swift.xml`, needs: null },
    affected: { none: 'AFFECTED_NONE: swift has no per-file test command; run the full gate or declare affectedSuites' },
    // swift test --xunit-output writes classname Module.Class and no file attribute; SwiftPM keeps tests in Tests/<Module>/<Class>.swift.
    cases: { name: 'swift', inputs: [], file: row => {
      const [module, cls] = (row.classname || '').split('.');
      return module && cls ? `Tests/${module}/${cls}.swift` : null;
    } },
  },
  {
    language: 'typescript',
    detect: null,
    tests: [],
    toolchains: null,
    junit: null,
    affected: null,
    // vitest --reporter=junit writes the test file path as classname and no file attribute (src/math.test.ts).
    cases: { name: 'typescript', inputs: [], file: row => (/\.(test|spec)\.[cm]?[jt]sx?$/u.test(row.classname ?? '') ? row.classname : null) },
  },
]);

/** The extra ecosystem rows, in detection order: the LANGUAGES rows whose detect is a table entry, as a view so no row has a second copy [C7]. */
export const LANGUAGE_ROWS = Object.freeze(LANGUAGES
  .filter((row) => row.detect !== null && typeof row.detect === 'object')
  .map((row) => ({ language: row.language, ...row.detect, tests: row.tests })));
