/** The gate command that writes a JUnit report, per detected language, and where the report lands [C7]. */
import { nodeJunitCommand } from './language-rows.js';

/** The folder each single-file report goes in, so one gate.junitReport folder can hold every language. */
const DIR = '.pullboard/junit';

/**
 * One row per language detectLanguages can return, except make, which has no report form.
 * needs names the extra package or config the tool requires before it can write JUnit; null when the tool writes it alone.
 */
const ROWS = Object.freeze({
  bun: { command: `bun test --reporter=junit --reporter-outfile=${DIR}/bun.xml`, report: `${DIR}/bun.xml`, needs: null },
  cmake: { command: `cmake -S . -B build && cmake --build build && ctest --test-dir build --output-junit ../${DIR}/cmake.xml`, report: `${DIR}/cmake.xml`, needs: null },
  csharp: { command: `dotnet test --logger "junit;LogFilePath=$PWD/${DIR}/csharp.xml"`, report: `${DIR}/csharp.xml`, needs: 'the JunitXml.TestLogger package in each test project' },
  deno: { command: `deno test --reporter=junit --junit-path=${DIR}/deno.xml`, report: `${DIR}/deno.xml`, needs: null },
  elixir: { command: 'mix test', report: `${DIR}/elixir.xml`, needs: `the junit_formatter dependency as an ExUnit formatter, with report_dir "${DIR}" and report_file "elixir.xml"` },
  go: { command: `gotestsum --junitfile ${DIR}/go.xml -- ./...`, report: `${DIR}/go.xml`, needs: 'gotestsum (go install gotest.tools/gotestsum@latest)' },
  gradle: { command: './gradlew test', report: 'build/test-results/test', needs: null },
  maven: { command: 'mvn test', report: 'target/surefire-reports', needs: null },
  node: { command: nodeJunitCommand(`${DIR}/node.xml`), report: `${DIR}/node.xml`, needs: null },
  php: { command: `vendor/bin/phpunit --log-junit ${DIR}/php.xml`, report: `${DIR}/php.xml`, needs: null },
  python: { command: `pytest --junitxml=${DIR}/python.xml`, report: `${DIR}/python.xml`, needs: null },
  ruby: { command: `bundle exec rspec --format RspecJunitFormatter --out ${DIR}/ruby.xml`, report: `${DIR}/ruby.xml`, needs: 'the rspec_junit_formatter gem in the Gemfile test group' },
  rust: { command: 'cargo nextest run --profile ci', report: 'target/nextest/ci/junit.xml', needs: 'cargo-nextest and a [profile.ci.junit] path = "junit.xml" entry in .config/nextest.toml' },
  swift: { command: `swift test --xunit-output ${DIR}/swift.xml`, report: `${DIR}/swift.xml`, needs: null },
});

/**
 * The JUnit-writing command for one language: the command, the report file or folder it writes, and any extra package it needs.
 * Why: init sets a plain test command, so landing names no failure of a non-Node repo until a person finds each tool's report flag.
 *
 * @param {string} language a language name as detectLanguages returns it
 * @returns {{ command: string, report: string, needs: string | null } | null} null for make or an unknown name, never a guess
 */
export function junitCommand(language) {
  if (typeof language !== 'string' || !Object.hasOwn(ROWS, language)) return null;
  return { ...ROWS[language] };
}

/** Every language with a report form, sorted. */
export const JUNIT_LANGUAGES = Object.freeze(Object.keys(ROWS).sort());
