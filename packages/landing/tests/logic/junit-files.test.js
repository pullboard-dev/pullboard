/** @pullboard-test-input source-cell packages/landing */
/** @pullboard-world-pin: the clause 3 cases read this file and the cell's registry.json to check that every title is registered. */
/** The junit-files adapter table: each language row maps one report case to the repo file a person must open [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { LANGUAGES } from '../../../gate/light.js';
import { JUNIT_FILE_ROWS } from '../../src/logic/junit-files.js';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.zig-classname-is-the-file: clause 1: junitFile zig returns the classname of a row whose classname ends in .zig [C7]', () => {
  assert.equal(junitFile('zig', { classname: 'src/calc.zig' }), 'src/calc.zig');
  assert.equal(junitFile('zig', { classname: 'src/calc.cpp' }), null);
});

test('landing.junit-files.zig-no-classname-is-null: clause 2: junitFile zig returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('zig', {}), null);
  assert.equal(junitFile('zig', { classname: '' }), null);
});

test('landing.junit-files.zig-titles-registered: clause 3: every zig test title here carries an ID starting landing.junit-files.zig with a registry record [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const ids = [...source.matchAll(/^test\('(landing\.junit-files\.zig-[^':\s]+): /gmu)].map(match => match[1]);
  assert.ok(ids.length >= 3);
  for (const id of ids) assert.ok(Object.hasOwn(records, id), id);
});

test('landing.junit-files.crystal-classname-is-the-spec-file: clause 1: junitFile crystal returns the classname of a row whose classname ends in .cr [C7]', () => {
  assert.equal(junitFile('crystal', { classname: 'spec/calc_spec.cr' }), 'spec/calc_spec.cr');
});

test('landing.junit-files.crystal-non-cr-classname-is-null: clause 2: junitFile crystal returns null for a row whose classname does not end in .cr [C7]', () => {
  assert.equal(junitFile('crystal', { classname: 'Calc' }), null);
  assert.equal(junitFile('crystal', {}), null);
});

test('landing.junit-files.crystal-titles-registered: clause 3: every crystal test title here carries an ID starting landing.junit-files.crystal with a registry record [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const ids = [...source.matchAll(/^test\('(landing\.junit-files\.crystal-[^':\s]+): /gmu)].map(match => match[1]);
  assert.ok(ids.length >= 3);
  for (const id of ids) assert.ok(Object.hasOwn(records, id), id);
});

test('landing.junit-files.ocaml-classname-is-the-test-file: clause 1: junitFile ocaml returns the lowercased classname with the .ml extension under the test folder [C7]', () => {
  assert.equal(junitFile('ocaml', { classname: 'Calc' }), 'test/calc.ml');
});

test('landing.junit-files.ocaml-no-classname-is-null: clause 2: junitFile ocaml returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('ocaml', {}), null);
  assert.equal(junitFile('ocaml', { classname: '' }), null);
});

test('landing.junit-files.ocaml-titles-registered: clause 3: every ocaml test title here carries an ID starting landing.junit-files.ocaml with a registry record [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const ids = [...source.matchAll(/^test\('(landing\.junit-files\.ocaml-[^':\s]+): /gmu)].map(match => match[1]);
  assert.ok(ids.length >= 3);
  for (const id of ids) assert.ok(Object.hasOwn(records, id), id);
});

test('landing.junit-files.clojure-namespace-to-file: clause 1: junitFile(clojure, row) turns a namespace classname into a test folder path, dots to folders and hyphens to underscores [C7]', () => {
  assert.equal(junitFile('clojure', { classname: 'my-app.core-test' }), 'test/my_app/core_test.clj');
});

test('landing.junit-files.clojure-no-classname: clause 2: junitFile(clojure, row) returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('clojure', {}), null);
});

test('landing.junit-files.clojure-registry-records: clause 3: every clojure title in this file has an ID starting landing.junit-files.clojure and a record in registry.json [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const own = Object.keys(records).filter(id => id.startsWith('landing.junit-files.clojure'));
  assert.ok(own.length >= 3);
  const titles = [...readFileSync(import.meta.filename, 'utf8').matchAll(/^test\('(landing\.junit-files\.clojure[^':\s]*): /gmu)].map(m => m[1]);
  assert.deepEqual(titles.filter(id => !Object.hasOwn(records, id)), []);
});

test('landing.junit-files.julia-runtests-file: clause 1: junitFile(julia, row) returns test/runtests.jl for a row with any classname [C7]', () => {
  assert.equal(junitFile('julia', { classname: 'MyPkg' }), 'test/runtests.jl');
});

test('landing.junit-files.julia-no-classname: clause 2: junitFile(julia, row) returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('julia', {}), null);
});

test('landing.junit-files.julia-registry-records: clause 3: every julia title in this file has an ID starting landing.junit-files.julia and a record in registry.json [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const own = Object.keys(records).filter(id => id.startsWith('landing.junit-files.julia'));
  assert.ok(own.length >= 3);
  const titles = [...readFileSync(import.meta.filename, 'utf8').matchAll(/^test\('(landing\.junit-files\.julia[^':\s]*): /gmu)].map(m => m[1]);
  assert.deepEqual(titles.filter(id => !Object.hasOwn(records, id)), []);
});

test('landing.junit-files.nim-test-file: clause 1: junitFile(nim, row) returns the classname with the .nim extension under the tests folder [C7]', () => {
  assert.equal(junitFile('nim', { classname: 'tcalc' }), 'tests/tcalc.nim');
  assert.equal(junitFile('nim', { classname: 'tcalc.nim' }), 'tests/tcalc.nim');
});

test('landing.junit-files.nim-no-classname: clause 2: junitFile(nim, row) returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('nim', {}), null);
});

test('landing.junit-files.nim-registry-records: clause 3: every nim title in this file has an ID starting landing.junit-files.nim and a record in registry.json [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const own = Object.keys(records).filter(id => id.startsWith('landing.junit-files.nim'));
  assert.ok(own.length >= 3);
  const titles = [...readFileSync(import.meta.filename, 'utf8').matchAll(/^test\('(landing\.junit-files\.nim[^':\s]*): /gmu)].map(m => m[1]);
  assert.deepEqual(titles.filter(id => !Object.hasOwn(records, id)), []);
});

test('landing.junit-files.deno-classname-is-the-test-file: clause 1: junitFile deno returns the path in classname after any file:// prefix and the checkout-root part is removed [C7]', () => {
  assert.equal(junitFile('deno', { classname: 'file:///work/repo/tests/calc_test.ts', root: '/work/repo' }), 'tests/calc_test.ts');
  assert.equal(junitFile('deno', { classname: 'tests/calc_test.ts' }), 'tests/calc_test.ts');
  assert.equal(junitFile('deno', { classname: 'file:///elsewhere/calc_test.ts', root: '/work/repo' }), null);
});

test('landing.junit-files.deno-no-classname-is-null: clause 2: junitFile deno returns null for a row with no classname [C7]', () => {
  assert.equal(junitFile('deno', {}), null);
  assert.equal(junitFile('deno', { classname: '' }), null);
});

test('landing.junit-files.deno-titles-registered: clause 3: every deno test title here carries an ID starting landing.junit-files.deno with a registry record [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const ids = [...source.matchAll(/^test\('(landing\.junit-files\.deno-[^':\s]+): /gmu)].map(match => match[1]);
  assert.ok(ids.length >= 3);
  for (const id of ids) assert.ok(Object.hasOwn(records, id), id);
});

/** The table as main held it before it became a view of the LANGUAGES cases facet (the 25 rows copied verbatim). */
const BEFORE = {
  // rspec_junit_formatter writes classname as the dotted spec path (spec.calc_spec) and usually a file attribute too.
  ruby: row => (row.classname ? `${row.classname.replace(/\./gu, '/')}.rb` : null),
  // pytest writes a dotted module in classname (tests.test_math) and no file attribute.
  python: row => (row.classname ? `${row.classname.replace(/\./gu, '/')}.py` : null),
  // hspec-junit-formatter writes the dotted spec module (Data.CalcSpec) in classname and no file attribute; a module ending in Spec is the spec file's own path (Data/CalcSpec.hs), a bare group (Calc) is test/CalcSpec.hs.
  haskell: row => (row.classname ? (/Spec$/u.test(row.classname) ? `${row.classname.replace(/\./gu, '/')}.hs` : `test/${row.classname.replace(/\./gu, '/')}Spec.hs`) : null),
  // dart test with junitreport writes the test file path (test/calc_test.dart) in classname and no file attribute.
  dart: row => (row.classname && /\.dart$/u.test(row.classname) ? row.classname : null),
  // crystal spec --junit writes the spec file path (spec/calc_spec.cr) in classname and no file attribute on the case.
  crystal: row => (row.classname && /\.cr$/u.test(row.classname) ? row.classname : null),
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
  // dune test with an OCaml JUnit reporter (alcotest or ounit2 output) writes the suite name in classname (Calc) and no file attribute; dune keeps it in test/calc.ml.
  ocaml: row => (row.classname ? `test/${row.classname.toLowerCase()}.ml` : null),
  // vitest --reporter=junit writes the test file path as classname and no file attribute (src/math.test.ts).
  typescript: row => (/\.(test|spec)\.[cm]?[jt]sx?$/u.test(row.classname ?? '') ? row.classname : null),
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
  // dotnet test (JunitXml.TestLogger) writes namespace.Class in classname and no file attribute; the first segment names the test project directory.
  csharp: row => {
    const project = (row.classname ?? '').split('.')[0];
    return project ? `${project}/` : null;
  },
  // phpunit writes the file attribute (absolute, inside the checkout); when it is absent the class name (Tests\MathTest or Tests.MathTest) maps to tests/MathTest.php.
  php: row => {
    const name = (row.classname ?? '').split(/[\\.]/u).pop();
    return name ? `tests/${name}.php` : null;
  },
  // prove with TAP::Formatter::JUnit names the suite after the script path with separators turned to underscores (t_calc_t).
  // Julia's Test suite JUnit report names the testset in classname and no file attribute; Pkg.test runs the one test/runtests.jl.
  julia: row => (row.classname ? 'test/runtests.jl' : null),
  // nim unittest's JUnit output names the test file module in classname (tcalc) and no file attribute; nimble keeps tests in tests/<name>.nim.
  nim: row => (row.classname ? `tests/${row.classname.replace(/\.nim$/u, '')}.nim` : null),
  // lein test / kaocha junit writes the namespace in classname (my-app.core-test) and no file attribute; dots are folders and hyphens are underscores under test/.
  clojure: row => (row.classname ? `test/${row.classname.replace(/-/gu, '_').replace(/\./gu, '/')}.clj` : null),
  perl: row => (row.classname ? row.classname.replace(/_t$/u, '.t').replace(/_/gu, '/') : null),
  // A Zig JUnit reporter (zig build test has no built-in one) writes the test file path (src/calc.zig) in classname and no file attribute.
  zig: row => (row.classname && /\.zig$/u.test(row.classname) ? row.classname : null),
  // deno test --junit-path writes the test file as a file:// URL in classname and no file attribute; the checkout root (row.root when given) is removed, and an absolute path outside it stays null (never guess).
  deno: row => {
    const path = (row.classname ?? '').replace(/^file:\/\//u, '');
    if (!path) return null;
    if (!path.startsWith('/')) return path;
    return row.root && path.startsWith(`${row.root.replace(/\/$/u, '')}/`) ? path.slice(row.root.replace(/\/$/u, '').length + 1) : null;
  },
};

/** A function's source with every run of whitespace collapsed, so a copy at another indent is the same copy. */
const collapse = fn => String(fn).replace(/\s+/gu, ' ');

test('landing.junit-files.table: clause 2: every JUNIT_FILE_ROWS key and function source equals the copy main held before it read LANGUAGES, and the deno row declares root as an extra input [C7]', () => {
  assert.deepEqual(Object.keys(JUNIT_FILE_ROWS).sort(), Object.keys(BEFORE).sort());
  for (const key of Object.keys(BEFORE)) assert.equal(collapse(JUNIT_FILE_ROWS[key]), collapse(BEFORE[key]), key);
  assert.deepEqual(LANGUAGES.find(row => row.language === 'deno').cases.inputs, ['root']);
});

test('landing.junit-files.cmake-reads-the-cpp-row: clause 1: junitFile cmake returns the same value junitFile cpp returns for a ctest classname [C7]', () => {
  assert.equal(junitFile('cmake', { classname: 'calc_test' }), 'calc_test');
  assert.equal(junitFile('cmake', { classname: 'calc_test' }), junitFile('cpp', { classname: 'calc_test' }));
});

test('landing.junit-files.cmake-no-classname-is-null: clause 2: junitFile cmake returns null for a row with no classname [C7]', () => {
  assert.equal(junitFile('cmake', {}), null);
  assert.equal(junitFile('cmake', { classname: '' }), null);
});

test('landing.junit-files.cmake-titles-registered: clause 3: every cmake test title here carries an ID starting landing.junit-files.cmake with a registry record [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const ids = [...source.matchAll(/^test\('(landing\.junit-files\.cmake-[^':\s]+): /gmu)].map(match => match[1]);
  assert.ok(ids.length >= 3);
  for (const id of ids) assert.ok(Object.hasOwn(records, id), id);
});

test('landing.junit-files.maven-reads-the-java-row: clause 1: junitFile maven returns the same path junitFile java returns for a Surefire dotted classname [C7]', () => {
  const row = { classname: 'com.example.CalcTest$Inner' };
  assert.equal(junitFile('maven', row), 'src/test/java/com/example/CalcTest.java');
  assert.equal(junitFile('maven', row), junitFile('java', row));
});

test('landing.junit-files.maven-no-classname-is-null: clause 2: junitFile maven returns null for a row with no classname [C7]', () => {
  assert.equal(junitFile('maven', {}), null);
  assert.equal(junitFile('maven', { classname: '' }), null);
});

test('landing.junit-files.maven-titles-registered: clause 3: every maven test title here carries an ID starting landing.junit-files.maven with a registry record [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const ids = [...source.matchAll(/^test\('(landing\.junit-files\.maven-[^':\s]+): /gmu)].map(match => match[1]);
  assert.ok(ids.length >= 3);
  for (const id of ids) assert.ok(Object.hasOwn(records, id), id);
});

test('landing.junit-files.haskell-dotted-module-path: clause 1: junitFile haskell returns the dotted spec module as a path with dots turned into folder separators and the .hs suffix [C7]', () => {
  assert.equal(junitFile('haskell', { classname: 'Data.CalcSpec' }), 'Data/CalcSpec.hs');
  assert.equal(junitFile('haskell', { classname: 'CalcSpec' }), 'CalcSpec.hs');
  assert.equal(junitFile('haskell', { classname: 'Calc' }), 'test/CalcSpec.hs');
});

test('landing.junit-files.haskell-no-classname-is-null: clause 2: junitFile haskell returns null for a row with no classname [C7]', () => {
  assert.equal(junitFile('haskell', {}), null);
  assert.equal(junitFile('haskell', { classname: '' }), null);
});

test('landing.junit-files.haskell-titles-registered: clause 3: every haskell test title here carries an ID starting landing.junit-files.haskell with a registry record [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const ids = [...source.matchAll(/^test\('(landing\.junit-files\.haskell-[^':\s]+): /gmu)].map(match => match[1]);
  assert.ok(ids.length >= 3);
  for (const id of ids) assert.ok(Object.hasOwn(records, id), id);
});

test('landing.junit-files.gradle-java-or-kotlin-path: clause 1: junitFile gradle returns the java path for a classname whose source is Java and the kotlin path for a Kotlin one [C7]', () => {
  assert.equal(junitFile('gradle', { classname: 'com.example.CalcTest' }), 'src/test/java/com/example/CalcTest.java');
  assert.equal(junitFile('gradle', { classname: 'com.example.CalcTest', kotlin: true }), 'src/test/kotlin/com/example/CalcTest.kt');
});

test('landing.junit-files.gradle-no-classname-is-null: clause 2: junitFile gradle returns null for a row with no classname [C7]', () => {
  assert.equal(junitFile('gradle', {}), null);
  assert.equal(junitFile('gradle', { kotlin: true }), null);
});

test('landing.junit-files.gradle-titles-registered: clause 3: every gradle test title here carries an ID starting landing.junit-files.gradle with a registry record [C7]', () => {
  const records = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'fixtures', 'registry.json'), 'utf8'));
  const source = readFileSync(import.meta.filename, 'utf8');
  const ids = [...source.matchAll(/^test\('(landing\.junit-files\.gradle-[^':\s]+): /gmu)].map(match => match[1]);
  assert.ok(ids.length >= 3);
  for (const id of ids) assert.ok(Object.hasOwn(records, id), id);
});
