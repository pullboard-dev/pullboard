/** @pullboard-test-input source-cell gate */
/** A plain Python repo with only test_*.py files gets python3 -m unittest as its gate, and any pytest marker keeps pytest [C7,#10366]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { detectGate } from '../../src/io/config.js';
import { detectLanguages } from '../../src/io/config.js';
import { detectTestGlobs } from '../../src/io/config.js';
import { languageToolchains } from '../../src/io/config.js';
import { privateFixtureFiles } from '../fixtures/child.js';

/** Make a repo root holding the given files, removed after the test. */
function rootWith(t, files) {
  const { root, write } = privateFixtureFiles('config-python-unittest-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) write(name, text);
  return root;
}

const PASSING = 'import unittest\n\nclass Ok(unittest.TestCase):\n    def test_ok(self):\n        self.assertEqual(1, 1)\n';
const FAILING = 'import unittest\n\nclass Bad(unittest.TestCase):\n    def test_bad(self):\n        self.assertEqual(1, 2)\n';

test('gate.config.python-unittest-detected: #10366 clause 1: a root with a test_ file at its top or in a tests folder and no python marker detects python3 -m unittest discover [C7]', (t) => {
  const top = rootWith(t, { 'test_a.py': PASSING });
  assert.deepEqual(detectLanguages(top), [{ language: 'python', command: 'python3 -m unittest discover' }]);
  const nested = rootWith(t, { 'tests/test_a.py': PASSING });
  assert.deepEqual(detectLanguages(nested), [{ language: 'python', command: 'python3 -m unittest discover -s tests' }]);
  const none = rootWith(t, { 'notes.py': 'x = 1\n' });
  assert.deepEqual(detectLanguages(none), []);
});

test('gate.config.python-pytest-marker-wins: #10366 clause 2: any pytest marker keeps the pytest command even beside test_ files [C7]', (t) => {
  for (const marker of ['pytest.ini', 'pyproject.toml', 'setup.py', 'requirements.txt']) {
    const root = rootWith(t, { [marker]: '', 'test_a.py': PASSING });
    assert.deepEqual(detectLanguages(root), [{ language: 'python', command: 'pytest' }], marker);
  }
});

test('gate.config.python-unittest-runs: #10366 clause 3: the detected command exits non-zero on a failing unittest and zero on a passing one [C7]', (t) => {
  if (spawnSync('python3', ['--version'], { encoding: 'utf8' }).status !== 0) { t.skip('python3 unavailable on this machine'); return; }
  for (const [files, status] of [[{ 'test_a.py': PASSING }, 0], [{ 'test_a.py': PASSING, 'test_b.py': FAILING }, 1], [{ 'tests/test_a.py': PASSING }, 0], [{ 'tests/test_b.py': FAILING }, 1]]) {
    const root = rootWith(t, files);
    const [{ command }] = detectLanguages(root);
    const run = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: 60000 });
    assert.equal(run.status === 0 ? 0 : 1, status, `${command} in ${Object.keys(files).join(',')}: ${run.stderr}`);
  }
});

test('gate.config.zig-detected: #10509 clause 1: a root holding build.zig detects zig with zig build test [C7]', (t) => {
  const root = rootWith(t, { 'build.zig': 'const std = @import("std");\n' });
  assert.deepEqual(detectLanguages(root), [{ language: 'zig', command: 'zig build test' }]);
  assert.deepEqual(detectLanguages(rootWith(t, { 'main.zig': '' })), []);
});

test('gate.config.zig-globs: #10509 clause 2: detectTestGlobs for a build.zig root returns the Zig test globs of the zig row, and the zig toolchain is known [C7]', (t) => {
  const root = rootWith(t, { 'build.zig': '' });
  assert.deepEqual(detectTestGlobs(root), ['**/*_test.zig', '**/test/**/*.zig', '**/tests/**/*.zig']);
  assert.deepEqual(languageToolchains(detectLanguages(root)), { toolchains: ['zig'], unknown: [] });
});

test('gate.config.julia-detected: #10513 clause 1: a root holding Project.toml and test/runtests.jl detects julia with a Pkg.test command [C7]', (t) => {
  const root = rootWith(t, { 'Project.toml': 'name = "App"\n', 'test/runtests.jl': 'using Test\n' });
  assert.deepEqual(detectLanguages(root), [{ language: 'julia', command: "julia --project -e 'using Pkg; Pkg.test()'" }]);
  assert.deepEqual(detectTestGlobs(root), ['test/**/*.jl', '**/runtests.jl']);
  assert.deepEqual(languageToolchains(detectLanguages(root)), { toolchains: ['julia'], unknown: [] });
});

test('gate.config.julia-no-tests: #10513 clause 2: a root holding Project.toml with no test folder detects nothing [C7]', (t) => {
  assert.deepEqual(detectLanguages(rootWith(t, { 'Project.toml': 'name = "App"\n' })), []);
  assert.deepEqual(detectLanguages(rootWith(t, { 'Project.toml': '', 'test/other.jl': '' })), []);
});

test('gate.config.ocaml-detected: #10510 clause 1: a root holding dune-project detects ocaml with dune test [C7]', (t) => {
  const root = rootWith(t, { 'dune-project': '(lang dune 3.0)\n' });
  assert.deepEqual(detectLanguages(root), [{ language: 'ocaml', command: 'dune test' }]);
  assert.deepEqual(detectLanguages(rootWith(t, { 'main.ml': '' })), []);
});

test('gate.config.ocaml-globs: #10510 clause 2: detectTestGlobs for a dune-project root returns the OCaml test globs of the ocaml row, and the dune toolchain is known [C7]', (t) => {
  const root = rootWith(t, { 'dune-project': '' });
  assert.deepEqual(detectTestGlobs(root), ['**/test/**/*.ml', '**/tests/**/*.ml', '**/*_test.ml']);
  assert.deepEqual(languageToolchains(detectLanguages(root)), { toolchains: ['dune'], unknown: [] });
});

test('gate.config.clojure-lein: #10511 clause 1: a root holding project.clj detects clojure with lein test [C7]', (t) => {
  const root = rootWith(t, { 'project.clj': '(defproject app "0.1.0")\n' });
  assert.deepEqual(detectLanguages(root), [{ language: 'clojure', command: 'lein test' }]);
  assert.deepEqual(languageToolchains(detectLanguages(root)), { toolchains: ['lein'], unknown: [] });
});

test('gate.config.clojure-deps: #10511 clause 2: a root holding only deps.edn detects clojure with clojure -M:test, and project.clj wins when both exist [C7]', (t) => {
  const root = rootWith(t, { 'deps.edn': '{}\n' });
  assert.deepEqual(detectLanguages(root), [{ language: 'clojure', command: 'clojure -M:test' }]);
  assert.deepEqual(languageToolchains(detectLanguages(root)), { toolchains: ['clojure'], unknown: [] });
  assert.deepEqual(detectLanguages(rootWith(t, { 'deps.edn': '{}\n', 'project.clj': '' })), [{ language: 'clojure', command: 'lein test' }]);
});

test('gate.config.clojure-globs: #10511 clause 3: detectTestGlobs for a clojure root returns the Clojure test globs of the clojure row [C7]', (t) => {
  assert.deepEqual(detectTestGlobs(rootWith(t, { 'deps.edn': '{}\n' })), ['test/**/*.clj', '**/*_test.clj']);
});

test('gate.config.nim-detected: #10514 clause 1: a root holding a .nimble file detects nim with nimble test [C7]', (t) => {
  const root = rootWith(t, { 'app.nimble': 'version = "0.1.0"\n' });
  assert.deepEqual(detectLanguages(root), [{ language: 'nim', command: 'nimble test' }]);
  assert.deepEqual(detectLanguages(rootWith(t, { 'main.nim': '' })), []);
});

test('gate.config.nim-globs: #10514 clause 2: detectTestGlobs for a .nimble root returns the Nim test globs of the nim row, and the nimble toolchain is known [C7]', (t) => {
  const root = rootWith(t, { 'app.nimble': '' });
  assert.deepEqual(detectTestGlobs(root), ['**/tests/**/*.nim', '**/test_*.nim']);
  assert.deepEqual(languageToolchains(detectLanguages(root)), { toolchains: ['nimble'], unknown: [] });
});

test('gate.config.nested-detected: #10367 clause 1: a root with no marker detects a go.mod one folder down and a node test script in another, each naming its folder, and the gate cds into each [C7]', (t) => {
  const root = rootWith(t, { 'api/go.mod': 'module api\n', 'web/package.json': '{"scripts":{"test":"node --test"}}\n', 'docs/readme.md': '' });
  assert.deepEqual(detectLanguages(root), [
    { language: 'go', command: 'go test ./...', folder: 'api' },
    { language: 'node', command: 'npm test', folder: 'web' },
  ]);
  assert.equal(detectGate(root), "(cd 'api' && go test ./...) && (cd 'web' && npm test)");
  assert.deepEqual(detectTestGlobs(root), ['api/**/*_test.go']);
});

test('gate.config.nested-root-wins: #10367 clause 2: a root that detects any language is not scanned below, exactly as before [C7]', (t) => {
  const root = rootWith(t, { 'go.mod': 'module app\n', 'svc/Cargo.toml': '[package]\n' });
  assert.deepEqual(detectLanguages(root), [{ language: 'go', command: 'go test ./...' }]);
  assert.equal(detectGate(root), 'go test ./...');
});

test('gate.config.nested-skips: #10367 clause 3: dot folders, node_modules, vendor and target are never scanned [C7]', (t) => {
  const root = rootWith(t, { '.hidden/go.mod': '', 'node_modules/go.mod': '', 'vendor/go.mod': '', 'target/go.mod': '' });
  assert.deepEqual(detectLanguages(root), []);
  assert.equal(detectGate(root), '');
});

test('gate.config.crystal-detected: #10512 clause 1: a root holding shard.yml detects crystal with crystal spec [C7]', (t) => {
  const root = rootWith(t, { 'shard.yml': 'name: app\nversion: 0.1.0\n' });
  assert.deepEqual(detectLanguages(root), [{ language: 'crystal', command: 'crystal spec' }]);
  assert.deepEqual(detectLanguages(rootWith(t, { 'main.cr': '' })), []);
});

test('gate.config.crystal-globs: #10512 clause 2: detectTestGlobs for a shard.yml root returns the Crystal spec globs of the crystal row, and the crystal toolchain is known [C7]', (t) => {
  const root = rootWith(t, { 'shard.yml': '' });
  assert.deepEqual(detectTestGlobs(root), ['spec/**/*_spec.cr', '**/spec/**/*_spec.cr']);
  assert.deepEqual(languageToolchains(detectLanguages(root)), { toolchains: ['crystal'], unknown: [] });
});
