/** Selection declarations bound runtime and non-module dependencies without evaluating candidate source [V4,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { test } from 'node:test';
import { selectAffectedTests } from '../../../index.js';
import { testClosures } from '../../../index.js';
import { runFixtureGit } from '../../fixtures/child.js';

/** Build actual immutable Git trees; no fixture module is imported or executed by selection. */
function graph(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-selection-fallbacks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  /** Run only fixture Git commands with the private identity and environment. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  /** Write exact candidate bytes, including declaration-looking strings used as negative controls. */
  const put = (path, source) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), source); };
  /** Commit a complete fixture graph before the selector can read it. */
  const commit = () => { git('add', '-A'); git('commit', '-qm', 'test: immutable selection graph'); return git('rev-parse', 'HEAD').trim(); };
  git('init', '-q', '-b', 'main');
  put('package.json', '{"type":"module","private":true}\n');
  put('src/value.js', 'export const value = 1;\n');
  put('test/value.test.js', "import '../src/value.js';\n");
  put('test/unrelated.test.js', "import assert from 'node:assert/strict'; assert.ok(true);\n");
  return { root, put, commit, git };
}

/** Observe a selective result without accepting an empty or accidentally full suite as the expected subset. */
function selected(box, base, commit, files) {
  const result = selectAffectedTests(box.root, { base, commit });
  assert.equal(result.full, false, result.reason);
  assert.deepEqual(result.files, files);
  return result;
}

test('gate.io-test-selection.quoted-input-markers-in-leading-prose: quoted input markers in leading prose leave real static importer closures known [V4,C7]', t => {
  const box = graph(t);
  const prose = '/**\n * Example header: /** @pullboard-test-input fixtures/missing.json *\\/\n */\n';
  box.put('src/prose.js', prose + 'export const value = 1;\n');
  box.put('test/prose.test.js', "import '../src/prose.js';\n");
  const base = box.commit();
  box.put('src/prose.js', prose + 'export const value = 2;\n');
  const after = box.commit();
  selected(box, base, after, ['test/prose.test.js']);
  assert.deepEqual(testClosures(box.root, after).closures.get('test/prose.test.js').files,
    ['src/prose.js', 'test/prose.test.js']);
  box.put('input.json', '{}\n');
  box.put('test/reader.test.js', '/** @pullboard-test-input input.json */\n' + prose);
  const declared = box.commit();
  box.put('input.json', '{"value":2}\n');
  const changed = box.commit();
  selected(box, declared, changed, ['test/reader.test.js']);
  assert.ok(testClosures(box.root, changed).closures.get('test/reader.test.js').files.includes('input.json'));
});

test('gate.io-test-selection.malformed-unmatched-and-unsafe-real-input: malformed, unmatched and unsafe real input annotations retain conservative fallback [V4,C7]', t => {
  for (const header of [
    '/** @pullboard-test-input */',
    '/* @pullboard-test-input fixtures/existing.json */',
    '// @pullboard-test-input fixtures/existing.json',
    '/**\n * @pullboard-test-input fixtures/existing.json\n */',
    '/** @pullboard-test-input fixtures/missing.json */',
    '/** @pullboard-test-input fixtures/missing-*.json */',
    '/** @pullboard-test-input ../outside.json */',
    '/** @pullboard-test-input /outside.json */',
    '/** @pullboard-test-input fixtures/{a,b}.json */',
    '/** @pullboard-test-input fixtures//existing.json */',
  ]) {
    const box = graph(t);
    box.put('fixtures/existing.json', '{}\n');
    box.put('src/value.js', header + '\nexport const value = 1;\n');
    const base = box.commit();
    box.put('src/value.js', header + '\nexport const value = 2;\n');
    const after = box.commit();
    const result = selectAffectedTests(box.root, { base, commit: after });
    assert.equal(result.full, true, header);
    assert.match(result.reason, /invalid or unmatched declared test input/u, header);
    assert.equal(testClosures(box.root, after).closures.get('test/value.test.js').files, null, header);
  }
});

test('gate.io-test-selection.declared-global-file-readers-and-ordinary: declared global-file readers and ordinary global module importers select their complete reach [V4,C7]', t => {
  const box = graph(t);
  box.put('src/widget.js', 'export const gate = 1;\n');
  box.put('test/widget.test.js', "import '../src/widget.js';\n");
  box.put('packages/gate/tests/logic/reach.test.js', '/** @pullboard-test-input package.json */\nimport { readFileSync } from "node:fs"; readFileSync("package.json");\n');
  const base = box.commit();
  box.put('src/widget.js', 'export const gate = 2;\n');
  const gate = box.commit();
  selected(box, base, gate, ['test/widget.test.js']);
  box.put('package.json', '{"type":"module","private":true,"description":"changed metadata"}\n');
  const metadata = box.commit();
  selected(box, gate, metadata, ['packages/gate/tests/logic/reach.test.js']);
});

test('gate.io-test-selection.declared-non-js-inputs-preserve-old: declared non-JS inputs preserve old and new readers through deletion and glob expansion [V4,C7]', t => {
  const box = graph(t);
  box.put('fixtures/first.json', '{"value":1}\n');
  box.put('fixtures/second.json', '{"value":2}\n');
  box.put('test/data.test.js', '/** @pullboard-test-input fixtures/*.json */\nimport { readFileSync } from "node:fs"; readFileSync(process.env.DATA);\n');
  const base = box.commit();
  box.git('rm', 'fixtures/first.json');
  const deleted = box.commit();
  selected(box, base, deleted, ['test/data.test.js']);
  box.put('fixtures/third.json', '{"value":3}\n');
  const added = box.commit();
  selected(box, deleted, added, ['test/data.test.js']);
});

test('gate.io-test-selection.declared-computed-and-commonjs-loaders-retain: declared computed and CommonJS loaders retain transitive dependencies in selections and closures [V4,C7]', t => {
  const box = graph(t);
  box.put('src/loader.cjs', '/** @pullboard-module-loads src/value.js */\nmodule.exports = () => require(process.env.TARGET);\n');
  box.put('test/commonjs.test.js', "import '../src/loader.cjs';\n");
  box.put('test/computed.test.js', '/** @pullboard-test-loads src/value.js */\nawait import(process.env.TARGET);\n');
  const base = box.commit();
  box.put('src/value.js', 'export const value = 2;\n');
  const commit = box.commit();
  selected(box, base, commit, ['test/commonjs.test.js', 'test/computed.test.js', 'test/value.test.js']);
  const closure = testClosures(box.root, commit).closures.get('test/commonjs.test.js');
  assert.equal(closure.reason, '');
  assert.ok(closure.files.includes('src/value.js'));
});

test('gate.io-test-selection.dependency-only-changes-retain-roots-with: dependency-only changes retain roots with an undeclared CommonJS reader without selecting known unrelated roots [V4,C7]', t => {
  const box = graph(t);
  rmSync(join(box.root, 'test/value.test.js'));
  box.put('src/reader.cjs', "module.exports = require('./value.js');\n");
  box.put('test/reader.test.js', "import '../src/reader.cjs';\n");
  const base = box.commit();
  const closure = testClosures(box.root, base).closures.get('test/reader.test.js');
  assert.equal(closure.files, null);
  assert.match(closure.reason, /CommonJS.*src\/reader\.cjs/u);
  box.put('src/value.js', 'export const value = 2;\n');
  const commit = box.commit();
  assert.deepEqual(box.git('diff', '--name-only', base, commit).trim(), 'src/value.js');
  selected(box, base, commit, ['test/reader.test.js']);
});

test('gate.io-test-selection.dependency-only-changes-retain-roots-with-2: dependency-only changes retain roots with an undeclared computed product loader without selecting known unrelated roots [V4,C7]', t => {
  const box = graph(t);
  rmSync(join(box.root, 'test/value.test.js'));
  box.put('src/reader.js', "const target = './value.js'; export const value = await import(target);\n");
  box.put('test/reader.test.js', "import '../src/reader.js';\n");
  const base = box.commit();
  const closure = testClosures(box.root, base).closures.get('test/reader.test.js');
  assert.equal(closure.files, null);
  assert.match(closure.reason, /non-literal dynamic import.*src\/reader\.js/u);
  box.put('src/value.js', 'export const value = 2;\n');
  const commit = box.commit();
  assert.deepEqual(box.git('diff', '--name-only', base, commit).trim(), 'src/value.js');
  selected(box, base, commit, ['test/reader.test.js']);
});

test('gate.io-test-selection.unresolved-data-and-executable-loaders-remain: unresolved data and executable loaders remain named full fallbacks without evaluating code [V4,C7]', t => {
  const box = graph(t);
  const base = box.commit();
  box.put('unknown.bin', 'opaque input\n');
  const data = box.commit();
  const unknown = selectAffectedTests(box.root, { base, commit: data });
  assert.equal(unknown.full, true);
  assert.match(unknown.reason, /unknown\.bin/u);
  box.git('rm', 'unknown.bin');
  box.put('src/opaque.js', 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); export const value = require(process.env.TARGET);\n');
  box.put('test/opaque.test.js', "import '../src/opaque.js';\n");
  const before = box.commit();
  box.put('src/opaque.js', 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url); export const value = require(process.env.OTHER);\n');
  const after = box.commit();
  const loader = selectAffectedTests(box.root, { base: before, commit: after });
  // A changed opaque loader selects its importers and stays a named unresolved root; it no longer selects every test [C7].
  assert.equal(loader.full, false, loader.reason);
  assert.deepEqual(loader.files, ['test/opaque.test.js']);
  assert.match(loader.reason, /CommonJS.*src\/opaque\.js/u);
});

test('gate.io-test-selection.declaration-text-inside-executable-strings-cannot: declaration text inside executable strings cannot hide an unknown non-JS input [V4,C7]', t => {
  const box = graph(t);
  box.put('test/fake.test.js', 'const banner = `/** @pullboard-test-input hidden.json */`;\n');
  const base = box.commit();
  box.put('hidden.json', '{}\n');
  const after = box.commit();
  const result = selectAffectedTests(box.root, { base, commit: after });
  assert.equal(result.full, true);
  assert.match(result.reason, /hidden\.json/u);
});

/** An explicit package.json reader cannot narrow away an implicit runtime effect of the named package field. */
function packageFieldEffect(t, field, value) {
  const box = graph(t);
  box.put('packages/gate/tests/logic/reach.test.js', '/** @pullboard-test-input package.json */\n');
  const base = box.commit();
  box.put('package.json', JSON.stringify({ type: 'module', private: true, [field]: value }) + '\n');
  const commit = box.commit();
  const result = selectAffectedTests(box.root, { base, commit });
  assert.equal(result.full, true, 'declared data reads cannot erase implicit runtime effects');
  assert.match(result.reason, /package|CommonJS/u);
}

/** A change to an implicit root file keeps its named full fallback. */
function implicitFileEffect(t, path) {
  const box = graph(t);
  const base = box.commit();
  box.put(path, '{}\n');
  const after = box.commit();
  const result = selectAffectedTests(box.root, { base, commit: after });
  assert.equal(result.full, true);
  assert.ok(result.reason.includes(path), result.reason);
}

test('gate.io-test-selection.package-type-effects-cannot-be-narrowed: package type effects cannot be narrowed by an explicit package reader [V4,C7]', t => packageFieldEffect(t, 'type', 'commonjs'));

test('gate.io-test-selection.package-imports-effects-cannot-be-narrowed: package imports effects cannot be narrowed by an explicit package reader [V4,C7]', t => packageFieldEffect(t, 'imports', { '#alias': './src/value.js' }));

test('gate.io-test-selection.package-exports-effects-cannot-be-narrowed: package exports effects cannot be narrowed by an explicit package reader [V4,C7]', t => packageFieldEffect(t, 'exports', './src/value.js'));

test('gate.io-test-selection.package-dependencies-effects-cannot-be-narrowed: package dependencies effects cannot be narrowed by an explicit package reader [V4,C7]', t => packageFieldEffect(t, 'dependencies', { opaque: '1.0.0' }));

test('gate.io-test-selection.package-scripts-effects-cannot-be-narrowed: package scripts effects cannot be narrowed by an explicit package reader [V4,C7]', t => packageFieldEffect(t, 'scripts', { test: 'node different.js' }));

test('gate.io-test-selection.package-engines-effects-cannot-be-narrowed: package engines effects cannot be narrowed by an explicit package reader [V4,C7]', t => packageFieldEffect(t, 'engines', { node: '>=24' }));

test('gate.io-test-selection.implicit-pullboardjson-effects-retain-their: implicit pullboard.json effects retain their named full fallback [V4,C7]', t => implicitFileEffect(t, 'pullboard.json'));

test('gate.io-test-selection.implicit-package-lockjson-effects-retain-their: implicit package-lock.json effects retain their named full fallback [V4,C7]', t => implicitFileEffect(t, 'package-lock.json'));

test('gate.io-test-selection.implicit-githooks-pre-commit-effects-retain-their: implicit .githooks/pre-commit effects retain their named full fallback [V4,C7]', t => implicitFileEffect(t, '.githooks/pre-commit'));

test('gate.io-test-selection.a-declared-data-symlink-cannot-supply: a declared data symlink cannot supply complete in-repository reader custody [V4,C7]', t => {
  const box = graph(t);
  box.put('test/data.test.js', '/** @pullboard-test-input input.json */\n');
  box.put('input.json', '{}\n');
  const base = box.commit();
  box.git('rm', 'input.json');
  symlinkSync('../outside.json', join(box.root, 'input.json'));
  const after = box.commit();
  const result = selectAffectedTests(box.root, { base, commit: after });
  assert.equal(result.full, true);
  assert.match(result.reason, /unsupported file mode/u);
});


test('gate.io-test-selection.an-explicit-data-header-preserves-the: an explicit data header preserves the same reader\'s leading source-tree declaration [V4,C7]', t => {
  const box = graph(t);
  box.put('input.json', '{}\n');
  box.put('test/tree.test.js', '/** @pullboard-test-input input.json */\n/** @pullboard-test-input source-tree */\n');
  const base = box.commit();
  box.put('src/value.js', 'export const value = 2;\n');
  const after = box.commit();
  selected(box, base, after, ['test/tree.test.js', 'test/value.test.js']);
});


test('gate.io-test-selection.exact-named-typescript-stripping-supplies-a: exact named TypeScript stripping supplies a non-loader import edge without executing it [V4,C7]', t => {
  const box = graph(t);
  box.put('src/utility.js', 'import { stripTypeScriptTypes } from "node:module"; export const parse = text => stripTypeScriptTypes(text);\n');
  box.put('test/utility.test.js', "import '../src/utility.js';\n");
  const base = box.commit();
  box.put('src/utility.js', 'import { stripTypeScriptTypes } from "node:module"; export const parse = text => stripTypeScriptTypes(text, { mode: "strip" });\n');
  const after = box.commit();
  selected(box, base, after, ['test/utility.test.js']);
  assert.equal(testClosures(box.root, after).closures.get('test/utility.test.js').reason, '');
});

test('gate.io-test-selection.non-loader-utility-recognition-cannot-hide: non-loader utility recognition cannot hide mixed, namespace, default or executable loading [V4,C7]', t => {
  const box = graph(t);
  box.put('test/utility.test.js', "import '../src/utility.js';\n");
  const sources = [
    'import { stripTypeScriptTypes, createRequire } from "node:module"; export const parse = createRequire(import.meta.url);',
    'import * as module from "node:module"; export const parse = module.stripTypeScriptTypes;',
    'import module from "node:module"; export const parse = module.stripTypeScriptTypes;',
    'import { register } from "node:module"; export const parse = register;',
    'import { stripTypeScriptTypes } from "node:module"; export const parse = process.getBuiltinModule("module").createRequire(import.meta.url);',
    'const banner = `import { stripTypeScriptTypes } from "node:module"`; import { createRequire } from "node:module"; export const parse = createRequire(import.meta.url);',
    'import { stripTypeScriptTypes } from "node:module"; export const parse = () => import(process.env.TARGET);',
  ];
  for (const source of sources) {
    box.put('src/utility.js', 'export const parse = text => text;\n');
    const base = box.commit();
    box.put('src/utility.js', source + '\n');
    const after = box.commit();
    const result = selectAffectedTests(box.root, { base, commit: after });
    // The changed loader file is an unresolved root retained by name; the unrelated tests stay out [C7].
    assert.equal(result.full, false, source);
    assert.deepEqual(result.files, ['test/utility.test.js'], source);
    assert.match(result.reason, /CommonJS|dynamic import/u, source);
  }
});
