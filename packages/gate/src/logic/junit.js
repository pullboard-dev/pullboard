/** Read a JUnit XML report into case outcomes, with a coded reason instead of a throw on damaged XML; also the report counts, clause ticks, per-language report commands and cargo libtest cases built on them [C7]. */
import { nodeJunitCommand } from './language-rows.js';

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };

/** Decode the five XML entities in an attribute value. */
function unescapeXml(text) {
  return text.replace(/&(?:lt|gt|quot|apos|amp);/gu, entity => ENTITIES[entity]);
}

/** The attributes of one tag's text as a name to value object. */
export function junitAttributes(tag) {
  const found = {};
  for (const match of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) found[match[1]] = unescapeXml(match[2] ?? match[3]);
  return found;
}

/** Each testcase name with pass, fail or skip; damaged or empty XML gives no cases and a reason code, never a throw [C7]. */
export function junitCases(xml) {
  if (typeof xml !== 'string' || !/<(?:testsuites|testsuite)[\s>]/u.test(xml)) return { cases: [], reason: 'JUNIT_UNREADABLE' };
  const opens = (xml.match(/<testcase\b/gu) ?? []).length;
  const closes = (xml.match(/<\/testsuite>/gu) ?? []).length + (xml.match(/<testsuite\b[^>]*\/>/gu) ?? []).length;
  const suites = (xml.match(/<testsuite\b/gu) ?? []).length;
  if (suites > closes || opens === 0 && !/<testsuite\b/u.test(xml)) return { cases: [], reason: 'JUNIT_DAMAGED' };
  const cases = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/gu)) {
    const name = junitAttributes(match[1]).name;
    if (name === undefined) return { cases: [], reason: 'JUNIT_DAMAGED' };
    const body = match[3] ?? '';
    const outcome = /<(?:failure|error)\b/u.test(body) ? 'fail' : /<skipped\b/u.test(body) ? 'skip' : 'pass';
    cases.push({ name, outcome });
  }
  if (opens !== cases.length) return { cases: [], reason: 'JUNIT_DAMAGED' };
  return { cases, reason: null };
}

/** Pass, fail and skip counts from a JUnit report, so a pytest or go run shows real receipt counts instead of "unknown" [C7]. Damaged or empty XML gives null counts and junitCases' reason code, never a throw. */
export function junitCounts(xml) {
  const { cases, reason } = junitCases(xml);
  if (reason !== null) return { pass: null, fail: null, skip: null, reason };
  const counts = { pass: 0, fail: 0, skip: 0, reason: null };
  for (const { outcome } of cases) counts[outcome] += 1;
  return counts;
}

/** Match a JUnit report's cases to an item's [test] clauses, deciding which to tick and which a failing case blocks [C7]. */

/** The clause number a case name starts with ("clause 3: ..."), or null when it names none. */
function clauseOf(name) {
  const match = /^clause\s+(\d+)\s*:/iu.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Which [test] clauses a report proves. `cases` is the `cases` list junitCases returns; `clauses` is a list of
 * `{ number, kind }`. Why: a clause whose named cases all passed is proved by the report; a failing case blocks its
 * clause and is named; a clause with no case in the report is left alone, neither ticked nor failed, and skipped
 * cases prove nothing. Pure: no I/O.
 */
export function junitClauseTicks(cases, clauses) {
  const ticked = [];
  const failed = [];
  for (const clause of clauses) {
    if (clause.kind !== 'test') continue;
    const mine = cases.filter(row => clauseOf(row.name) === clause.number);
    if (!mine.length) continue;
    const bad = mine.filter(row => row.outcome === 'fail');
    if (bad.length) { for (const row of bad) failed.push({ number: clause.number, name: row.name }); continue; }
    if (mine.every(row => row.outcome === 'pass')) ticked.push(clause.number);
  }
  return { ticked, failed };
}

/** The gate command that writes a JUnit report, per detected language, and where the report lands [C7]. */

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
  sbt: { command: 'sbt test', report: 'target/test-reports', needs: null },
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

/** Read plain `cargo test` (libtest) output into {name, outcome, message?} cases in the junitCases shape, with no extra tool [C7]. */
export function cargoTestCases(output) {
  if (typeof output !== 'string') return { cases: [], reason: 'CARGO_UNREADABLE' };
  const lines = output.split(/\r?\n/u);
  const cases = [];
  for (const line of lines) {
    const match = /^test (\S+) \.\.\. (ok|FAILED|ignored)\b/u.exec(line);
    if (match) cases.push({ name: match[1], outcome: match[2] === 'ok' ? 'pass' : match[2] === 'FAILED' ? 'fail' : 'skip' });
  }
  if (cases.length === 0) return { cases: [], reason: 'CARGO_UNREADABLE' };
  for (let at = 0; at < lines.length; at += 1) {
    const head = /^---- (\S+) stdout ----$/u.exec(lines[at]);
    if (!head) continue;
    const failing = cases.find(found => found.name === head[1] && found.outcome === 'fail' && found.message === undefined);
    if (!failing) continue;
    for (let next = at + 1; next < lines.length && !/^---- /u.test(lines[next]); next += 1) {
      if (/panicked at /u.test(lines[next])) { failing.message = lines[next].trim(); break; }
    }
  }
  return { cases, reason: null };
}

/* Per-language affected-test rows: the command that runs only what a change touches, and the unit selection picks by [C7]. Kept here so the gate light door loads no extra module for them. */

/** A file-unit row: the prefix runs each selected test file. */
const fileRow = command => ({ affectedTests: command, selectionUnit: 'file' });

/** The rows, by language. {units} is every selected unit in one command; {unit} repeats the command once per unit. */
const AFFECTED_ROWS = {
  python: fileRow('pytest'),
  node: fileRow('node --test'),
  go: { affectedTests: 'go test {units}', selectionUnit: 'package' },
  rust: { affectedTests: 'cargo test --manifest-path {unit}/Cargo.toml', selectionUnit: 'crate' },
  csharp: { affectedTests: 'dotnet test {unit}', selectionUnit: 'project' },
  php: fileRow('vendor/bin/phpunit'),
  ruby: fileRow('bundle exec rspec'),
  deno: fileRow('deno test'),
  bun: fileRow('bun test'),
};

/** Languages whose tests no file or unit command can narrow; they run the full gate or declare affectedSuites. */
const AFFECTED_NONE = {
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
  const row = AFFECTED_ROWS[language];
  if (row) return { ...row, reason: null };
  return { affectedTests: null, selectionUnit: null, reason: AFFECTED_NONE[language] ?? `AFFECTED_UNKNOWN: ${String(language)} has no affected-test row; run the full gate or declare affectedSuites` };
}

/** Every language that has a row or an explicit no-row answer. */
export const AFFECTED_LANGUAGES = [...Object.keys(AFFECTED_ROWS), ...Object.keys(AFFECTED_NONE)];
