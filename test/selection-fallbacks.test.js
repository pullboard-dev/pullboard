/** Selection declarations bound runtime and non-module dependencies without evaluating candidate source [V4,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { selectAffectedTests } from '../src/affected-tests.js';
import { testClosures } from '../src/affected-tests.js';
import { runFixtureGit } from './fixture-child.js';

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

test('declared global-file readers and ordinary global module importers select their complete reach [V4,C7]', t => {
  const box = graph(t);
  box.put('src/gate.js', 'export const gate = 1;\n');
  box.put('test/gate.test.js', "import '../src/gate.js';\n");
  box.put('test/package.test.js', '/** @pullboard-test-input package.json */\nimport { readFileSync } from "node:fs"; readFileSync("package.json");\n');
  const base = box.commit();
  box.put('src/gate.js', 'export const gate = 2;\n');
  const gate = box.commit();
  selected(box, base, gate, ['test/gate.test.js']);
  box.put('package.json', '{"type":"module","private":true,"description":"changed metadata"}\n');
  const metadata = box.commit();
  selected(box, gate, metadata, ['test/package.test.js']);
});

test('declared non-JS inputs preserve old and new readers through deletion and glob expansion [V4,C7]', t => {
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

test('declared computed and CommonJS loaders retain transitive dependencies in selections and closures [V4,C7]', t => {
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

test('unresolved data and executable loaders remain named full fallbacks without evaluating code [V4,C7]', t => {
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
  assert.equal(loader.full, true);
  assert.match(loader.reason, /CommonJS.*src\/opaque\.js/u);
});

test('declaration text inside executable strings cannot hide an unknown non-JS input [V4,C7]', t => {
  const box = graph(t);
  box.put('test/fake.test.js', 'const banner = `/** @pullboard-test-input hidden.json */`;\n');
  const base = box.commit();
  box.put('hidden.json', '{}\n');
  const after = box.commit();
  const result = selectAffectedTests(box.root, { base, commit: after });
  assert.equal(result.full, true);
  assert.match(result.reason, /hidden\.json/u);
});
