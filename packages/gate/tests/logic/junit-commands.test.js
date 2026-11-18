/** @pullboard-test-input source-cell gate */
/** @pullboard-world-pin: clause 3 reads the committed gate registry to check the clojure cases have records. */
/** Each detected language has a JUnit-writing gate command and a known report path [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { JUNIT_LANGUAGES } from '../../src/logic/junit.js';
import { junitCommand } from '../../src/logic/junit.js';
import { junitCommand as lightJunitCommand } from '../../light.js';

const LANGUAGES = ['bun', 'clojure', 'cmake', 'crystal', 'csharp', 'deno', 'elixir', 'go', 'gradle', 'haskell', 'julia', 'maven', 'node', 'perl', 'php', 'python', 'ruby', 'rust', 'sbt', 'swift'];
const TOOL_FOLDERS = { sbt: 'target/test-reports', gradle: 'build/test-results/test', maven: 'target/surefire-reports', rust: 'target/nextest/ci/junit.xml' };
const NEEDS = ['clojure', 'csharp', 'elixir', 'go', 'haskell', 'julia', 'perl', 'ruby', 'rust'];

test('gate.junit-commands.rows: clause 1: junitCommand returns command, report and needs for every detected language, the report under .pullboard/junit or the tool folder [C7]', () => {
  assert.deepEqual(JUNIT_LANGUAGES, LANGUAGES);
  for (const language of LANGUAGES) {
    const row = junitCommand(language);
    assert.ok(row, `${language} has a row`);
    assert.deepEqual(Object.keys(row).sort(), ['command', 'needs', 'report'], `${language} row shape`);
    assert.ok(typeof row.command === 'string' && row.command.trim(), `${language} command`);
    if (TOOL_FOLDERS[language]) assert.equal(row.report, TOOL_FOLDERS[language], `${language} uses its tool folder`);
    else assert.equal(row.report, `.pullboard/junit/${language}.xml`, `${language} report path`);
  }
  assert.equal(junitCommand('python').command, 'pytest --junitxml=.pullboard/junit/python.xml');
  assert.equal(junitCommand('swift').command, 'swift test --xunit-output .pullboard/junit/swift.xml');
  const copy = junitCommand('go');
  copy.command = 'changed';
  assert.notEqual(junitCommand('go').command, 'changed', 'a caller cannot change the table');
});

test('gate.junit-commands.no-guess: clause 2: make and unknown languages return null, never a guessed command [C7]', () => {
  for (const language of ['make', 'cobol', '', 'constructor', 'toString', '__proto__', null, undefined, 3]) {
    assert.equal(junitCommand(language), null, `${String(language)} has no row`);
  }
});

test('gate.junit-commands.needs: clause 3: rows that need an extra package name it, every other row has needs null [C7]', () => {
  const named = { clojure: /kaocha/u, csharp: /JunitXml\.TestLogger/u, elixir: /junit_formatter/u, go: /gotestsum/u, haskell: /hspec-junit-formatter/u, julia: /TestReports/u, perl: /TAP::Formatter::JUnit/u, ruby: /rspec_junit_formatter/u, rust: /cargo-nextest/u };
  for (const language of LANGUAGES) {
    const { needs } = junitCommand(language);
    if (NEEDS.includes(language)) assert.match(needs, named[language], `${language} names its package`);
    else assert.equal(needs, null, `${language} needs nothing extra`);
  }
});

test('gate.junit-commands.sbt-row: clause 1: junitCommand(sbt) returns its report command and needs, and JUNIT_LANGUAGES includes sbt [C7]', () => {
  const row = junitCommand('sbt');
  assert.equal(row.command, 'sbt test');
  assert.equal(row.report, 'target/test-reports');
  assert.equal(row.needs, null);
  assert.ok(JUNIT_LANGUAGES.includes('sbt'));
});

test('gate.junit-commands.sbt-door: clause 2: junitCommand(sbt) from the gate light door returns the same row init reads [C7]', () => {
  assert.deepEqual(lightJunitCommand('sbt'), junitCommand('sbt'));
});

test('gate.junit-commands.haskell-row: clause 1: junitCommand haskell runs cabal test with the hspec-junit-formatter variables, names the package and the junit folder report [C7]', () => {
  const row = junitCommand('haskell');
  assert.equal(row.command, 'JUNIT_ENABLED=1 JUNIT_OUTPUT_DIRECTORY=.pullboard/junit JUNIT_OUTPUT_NAME=haskell.xml cabal test');
  assert.equal(row.report, '.pullboard/junit/haskell.xml');
  assert.match(row.needs, /hspec-junit-formatter/u);
  assert.ok(JUNIT_LANGUAGES.includes('haskell'));
});

test('gate.junit-commands.haskell-door: clause 2: junitCommand imported from packages/gate/light.js returns the same haskell row [C7]', () => {
  assert.deepEqual(lightJunitCommand('haskell'), junitCommand('haskell'));
});

test('gate.junit-commands.perl-row: clause 1: junitCommand(perl) runs prove with the TAP::Formatter::JUnit formatter, reports perl.xml in the junit folder and names the formatter module [C7]', () => {
  const row = junitCommand('perl');
  assert.ok(row.command.startsWith('prove -lr --formatter TAP::Formatter::JUnit t'));
  assert.equal(row.report, '.pullboard/junit/perl.xml');
  assert.match(row.needs, /TAP::Formatter::JUnit/u);
  assert.ok(JUNIT_LANGUAGES.includes('perl'));
});

test('gate.junit-commands.perl-door: clause 2: junitCommand(perl) imported from packages/gate/light.js returns the same row init reads [C7]', () => {
  assert.deepEqual(lightJunitCommand('perl'), junitCommand('perl'));
});

test('gate.junit-commands.crystal-row: clause 1: junitCommand(crystal) returns its report command and needs, and JUNIT_LANGUAGES includes crystal [C7]', () => {
  const row = junitCommand('crystal');
  assert.ok(row.command.startsWith('crystal spec --junit_output'));
  assert.equal(row.report, '.pullboard/junit/crystal.xml');
  assert.equal(row.needs, null);
  assert.ok(JUNIT_LANGUAGES.includes('crystal'));
});

test('gate.junit-commands.crystal-door: clause 2: junitCommand(crystal) from the gate light door returns the same row init reads [C7]', () => {
  assert.deepEqual(lightJunitCommand('crystal'), junitCommand('crystal'));
});

test('gate.junit-commands.clojure-row: clause 1: junitCommand(clojure) returns the kaocha junit-xml command, the clojure.xml report and the kaocha need, and JUNIT_LANGUAGES includes clojure [C7]', () => {
  const row = junitCommand('clojure');
  assert.ok(row.command.startsWith('clojure -M:test'));
  assert.match(row.command, /--plugin kaocha\.plugin\/junit-xml --junit-xml-file \.pullboard\/junit\/clojure\.xml/u);
  assert.equal(row.report, '.pullboard/junit/clojure.xml');
  assert.match(row.needs, /kaocha/u);
  assert.ok(JUNIT_LANGUAGES.includes('clojure'));
});

test('gate.junit-commands.clojure-door: clause 2: junitCommand(clojure) imported from packages/gate/light.js returns the same clojure row [C7]', () => {
  assert.deepEqual(lightJunitCommand('clojure'), junitCommand('clojure'));
});

test('gate.junit-commands.clojure-registered: clause 3: the clojure row and door cases each carry an ID with a record in the gate registry [C7]', () => {
  const registry = JSON.parse(readFileSync(new URL('../fixtures/registry.json', import.meta.url), 'utf8'));
  const records = registry.tests ?? registry;
  for (const id of ['gate.junit-commands.clojure-row', 'gate.junit-commands.clojure-door', 'gate.junit-commands.clojure-registered']) {
    assert.ok(records[id], `${id} has a record`);
  }
});

test('gate.junit-commands.julia-row: clause 1: junitCommand(julia) runs the package tests through TestReports, writes julia.xml in the junit folder and names TestReports as needed, and JUNIT_LANGUAGES includes julia [C7]', () => {
  const row = junitCommand('julia');
  assert.ok(row.command.includes('TestReports.test('));
  assert.equal(row.report, '.pullboard/junit/julia.xml');
  assert.match(row.needs, /TestReports/u);
  assert.ok(JUNIT_LANGUAGES.includes('julia'));
});

test('gate.junit-commands.julia-door: clause 2: junitCommand(julia) imported from packages/gate/light.js, the door init language notes read, returns the same row [C7]', () => {
  assert.deepEqual(lightJunitCommand('julia'), junitCommand('julia'));
});

test('gate.junit-commands.julia-registered: clause 3: the julia row and door cases each carry an ID with a record in the gate registry [C7]', () => {
  const registry = JSON.parse(readFileSync(new URL('../fixtures/registry.json', import.meta.url), 'utf8'));
  const records = registry.tests ?? registry;
  for (const id of ['gate.junit-commands.julia-row', 'gate.junit-commands.julia-door', 'gate.junit-commands.julia-registered']) {
    assert.ok(records[id], `${id} has a record`);
  }
});
