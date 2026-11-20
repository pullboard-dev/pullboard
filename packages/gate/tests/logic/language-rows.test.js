/** @pullboard-test-input source-cell gate */
/** The LANGUAGES table holds one row per language and agrees with every gate table it replaces until the callers read it [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { detectLanguages } from '../../src/io/config.js';
import { detectTestGlobs } from '../../src/io/config.js';
import { languageToolchains } from '../../src/io/config.js';
import { TOOLCHAIN_LANGUAGES } from '../../src/io/config.js';
import { AFFECTED_LANGUAGES } from '../../src/logic/junit.js';
import { affectedRow } from '../../src/logic/junit.js';
import { junitCommand } from '../../src/logic/junit.js';
import { JUNIT_LANGUAGES } from '../../src/logic/junit.js';
import { LANGUAGE_ROWS } from '../../src/logic/language-rows.js';
import { LANGUAGES } from '../../src/logic/language-rows.js';
import { rowMatches } from '../../src/logic/language-rows.js';
import { privateFixtureFiles } from '../fixtures/child.js';

const SRC = join(import.meta.dirname, '..', '..', 'src');

/** The languages detectHere in src/io/config.js adds in code, in its order. */
const BUILT_IN = ['node', 'go', 'rust', 'python', 'php', 'elixir', 'csharp', 'cmake', 'make'];

/** One root file per built-in language, enough for detectHere to find it and nothing else. */
const BUILT_IN_ROOTS = {
  node: { 'package.json': '{"scripts":{"test":"node --test"}}' },
  go: { 'go.mod': 'module example.com/m\n' },
  rust: { 'Cargo.toml': '' },
  python: { 'pytest.ini': '' },
  php: { 'composer.json': '{"scripts":{"test":"phpunit"}}' },
  elixir: { 'mix.exs': '' },
  csharp: { 'app.sln': '' },
  cmake: { 'CMakeLists.txt': '' },
  make: { 'Makefile': 'test:\n\ttrue\n' },
};

/** Commands each function-valued toolchain row is asked about: every front tool the old rows tell apart. */
const COMMANDS = ['', 'npm test', 'pytest', 'uv run pytest', 'poetry run pytest', 'composer test', 'vendor/bin/phpunit', 'bundle exec rspec',
  'bundle exec rake test', 'rake test', 'ruby -Itest', 'gradle test', './gradlew test', 'lein test', 'clojure -M:test', 'stack test',
  'cabal test', 'flutter test', 'dart test', ...LANGUAGE_ROWS.map((row) => row.command).filter((command) => typeof command === 'string')];

/** Two row values are the same copy: equal function source, equal pattern, else deep equal. */
function sameCopy(actual, expected, what) {
  if (typeof expected === 'function') return assert.equal(String(actual), String(expected), what);
  if (expected instanceof RegExp) return assert.ok(actual instanceof RegExp && actual.source === expected.source && actual.flags === expected.flags, what);
  return assert.deepEqual(actual, expected, what);
}

test('gate.language-rows.detect-parity: clause 1: every LANGUAGE_ROWS row equals its LANGUAGES row in order, and the built-in rows are the nine detectHere languages with the test globs detectTestGlobs returns [C7]', (t) => {
  const rowDetected = LANGUAGES.filter((row) => row.detect !== null && typeof row.detect === 'object');
  assert.deepEqual(rowDetected.map((row) => row.language), LANGUAGE_ROWS.map((row) => row.language), 'the same rows in the same detection order');
  LANGUAGE_ROWS.forEach((old, at) => {
    const { language, tests, ...detect } = old;
    const row = rowDetected[at];
    assert.deepEqual(Object.keys(row.detect).sort(), Object.keys(detect).sort(), `${language}: the same detect fields`);
    for (const key of Object.keys(detect)) sameCopy(row.detect[key], detect[key], `${language}: detect.${key}`);
    sameCopy(row.tests, tests, `${language}: tests`);
  });
  assert.deepEqual(LANGUAGES.filter((row) => row.detect === 'built-in').map((row) => row.language), BUILT_IN);
  for (const language of BUILT_IN) {
    const { root, write } = privateFixtureFiles(`language-rows-${language}-`);
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const [name, text] of Object.entries(BUILT_IN_ROOTS[language])) write(name, text);
    assert.deepEqual(detectLanguages(root).map((entry) => entry.language), [language], `${language}: the fixture root detects only it`);
    const row = LANGUAGES.find((found) => found.language === language);
    assert.deepEqual(detectTestGlobs(root), [...new Set(row.tests)], `${language}: tests`);
  }
  assert.equal(new Set(LANGUAGES.map((row) => row.language)).size, LANGUAGES.length, 'one row per language');
});

test('gate.language-rows.facet-parity: clause 2: every LANGUAGES row answers what languageToolchains, junitCommand and affectedRow answer today, null where the old table has no row [C7]', () => {
  const ids = LANGUAGES.map((row) => row.language);
  for (const language of [...TOOLCHAIN_LANGUAGES, ...JUNIT_LANGUAGES, ...AFFECTED_LANGUAGES]) assert.ok(ids.includes(language), `${language} has a LANGUAGES row`);
  for (const row of LANGUAGES) {
    const { language } = row;
    if (!TOOLCHAIN_LANGUAGES.includes(language)) assert.equal(row.toolchains, null, `${language}: no toolchain row today`);
    else {
      for (const command of COMMANDS) {
        const names = typeof row.toolchains === 'function' ? row.toolchains(command) : row.toolchains;
        assert.deepEqual([...new Set(names)].sort(), languageToolchains([{ language, command }]).toolchains, `${language} '${command}': toolchains`);
      }
    }
    assert.deepEqual(row.junit, junitCommand(language), `${language}: junit`);
    const affected = affectedRow(language);
    if (row.affected === null) {
      assert.ok(!AFFECTED_LANGUAGES.includes(language), `${language}: no affected row today`);
      assert.match(affected.reason, /^AFFECTED_UNKNOWN: /u);
    } else if (row.affected.none) assert.deepEqual(affected, { affectedTests: null, selectionUnit: null, reason: row.affected.none }, `${language}: affected none`);
    else assert.deepEqual(affected, { ...row.affected, reason: null }, `${language}: affected`);
  }
});

test('gate.language-rows.no-new-module: clause 3: LANGUAGES lives in a module that imports nothing new and that junit.js already loads, so the light door loads no new module, and each cases row declares its extra inputs [C7]', () => {
  const source = readFileSync(join(SRC, 'logic', 'language-rows.js'), 'utf8');
  assert.deepEqual(source.match(/^import\b.*$/gmu) ?? [], [], 'language-rows.js imports no module');
  assert.match(readFileSync(join(SRC, 'logic', 'junit.js'), 'utf8'), /from '\.\/language-rows\.js';/u, 'junit.js, which the light door loads, already imports language-rows.js');
  for (const row of LANGUAGES) {
    if (row.cases) assert.ok(typeof row.cases.file === 'function' && Array.isArray(row.cases.inputs) && typeof row.cases.name === 'string', `${row.language}: cases has name, inputs and file`);
  }
  assert.deepEqual(LANGUAGES.find((row) => row.language === 'deno').cases.inputs, ['root'], 'the deno row declares root as an extra input');
});

test('gate.language-rows.completeness: clause 1: every LANGUAGES row with a detect facet also has tests and toolchains, every junit facet names a report path, and every cases facet declares its extra inputs [C7]', () => {
  for (const row of LANGUAGES) {
    const { language } = row;
    assert.ok(Object.hasOwn(row, 'detect') && Object.hasOwn(row, 'tests') && Object.hasOwn(row, 'toolchains') && Object.hasOwn(row, 'junit') && Object.hasOwn(row, 'affected') && Object.hasOwn(row, 'cases'), `${language}: every facet is present, null when none`);
    if (row.detect !== null) {
      assert.ok(Array.isArray(row.tests) || typeof row.tests === 'function', `${language}: a detected language has tests`);
      assert.ok(row.toolchains !== null && (Array.isArray(row.toolchains) || typeof row.toolchains === 'function'), `${language}: a detected language has toolchains`);
    }
    if (row.junit !== null) assert.ok(typeof row.junit.report === 'string' && row.junit.report.length > 0 && typeof row.junit.command === 'string', `${language}: the junit facet names a report path`);
    if (row.cases !== null) assert.ok(Array.isArray(row.cases.inputs) && row.cases.inputs.every((input) => typeof input === 'string'), `${language}: the cases facet declares its extra inputs`);
  }
  assert.deepEqual(LANGUAGES.find((row) => row.language === 'deno').cases.inputs, ['root'], 'deno declares root');
});

test('gate.language-rows.no-second-table: clause 2: no gate source outside language-rows.js holds a per-language table: config.js and junit.js name no language id as an object key [C7]', () => {
  const key = new RegExp(`(^|[{,])\\s*["']?(${LANGUAGES.map((row) => row.language).join('|')})["']?\\s*:`, 'mu');
  for (const file of [join('io', 'config.js'), join('logic', 'junit.js')]) {
    const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
    assert.deepEqual(lines.filter((line) => key.test(line)), [], `${file} names no language id as an object key`);
  }
});

test('gate.language-rows.swift-dart-detected: clause 1: a Package.swift root detects swift with swift test and its Tests glob [C7]', () => {
  const names = ['Package.swift'];
  const row = LANGUAGE_ROWS.find((found) => found.language === 'swift');
  assert.equal(rowMatches(row, names, () => null), true);
  assert.equal(row.command, 'swift test');
  assert.deepEqual(row.tests, ['**/Tests/**/*Tests.swift']);
  assert.equal(rowMatches(row, ['main.swift'], () => null), false);
});

test('gate.language-rows.dart-flutter-detected: clause 2: a pubspec.yaml detects dart test, and a flutter pubspec detects flutter test only [C7]', (t) => {
  const plain = privateFixtureFiles('language-rows-dart-');
  const flutter = privateFixtureFiles('language-rows-flutter-');
  t.after(() => rmSync(plain.root, { recursive: true, force: true }));
  t.after(() => rmSync(flutter.root, { recursive: true, force: true }));
  plain.write('pubspec.yaml', 'name: app\ndev_dependencies:\n  test: any\n');
  flutter.write('pubspec.yaml', 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n');
  assert.deepEqual(detectLanguages(plain.root), [{ language: 'dart', command: 'dart test' }]);
  assert.deepEqual(detectLanguages(flutter.root), [{ language: 'dart', command: 'flutter test' }]);
  assert.deepEqual(detectTestGlobs(flutter.root), ['**/*_test.dart']);
});
