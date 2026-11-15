/** @pullboard-test-input packages/gate/src/io/test/manifest.js packages/gate/src/io/test/scripts/manifest.js packages/gate/src/logic/test/manifest.js */
/** The test manifest gives every test file a kind, a recorded cost and what it spawns, derived from source alone [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { generateTestManifest } from '../../../../src/io/test/manifest.js';
import { runManifestCommand } from '../../../../src/io/test/manifest.js';
import { TEST_KINDS } from '../../../../src/logic/test/manifest.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../../../../apps/cli/tests/fixtures/child.js';

const SPAWN = 'import { spawnSync } from "node:child_process"; export const run = () => spawnSync("git");';

/** Write only synthetic sources in a private Git repository; the candidate sources are read, never run. */
function fixture(t, sources) {
  const files = privateFixtureFiles('pullboard-test-manifest-');
  t.after(() => rmSync(files.root, { recursive: true, force: true }));
  const sh = (...args) => runFixtureGit(args, { cwd: files.root });
  sh('init', '-q');
  for (const [file, source] of Object.entries({ 'package.json': '{"type":"module"}', ...sources })) files.write(file, source);
  sh('add', '-A');
  return files;
}

const SOURCES = {
  'packages/math/index.js': 'export const add = (a, b) => a + b;',
  'packages/math/tests/add.test.js': 'import { add } from "../index.js"; add(1, 2);',
  'packages/math/tests/store.test.js': 'import "../index.js"; fixtureBoard();',
  'packages/math/tests/git.test.js': `import "../index.js"; import { run } from "./fixtures/git.js"; run();`,
  'packages/math/tests/fixtures/git.js': SPAWN,
  'packages/math/tests/fixtures/git.test.js': 'import "./git.js";',
  'apps/cli/journeys/add/main.test.js': 'import "../../../../packages/math/index.js";',
  'test/root-spawn.test.js': `import "../packages/math/index.js"; ${SPAWN}; run();`,
  'test/root-pure.test.js': 'import "../packages/math/index.js";',
  'packages/math/tests/product-spawn.test.js': 'import "../src/spawns.js";',
  'packages/math/src/spawns.js': SPAWN,
};
const row = (manifest, file) => manifest.files.find(entry => entry.file === file);

test('every test file has one row, in order, and a fixture that is not a test file has none [C7]', t => {
  const manifest = generateTestManifest(fixture(t, SOURCES).root, { times: {} });
  const tests = Object.keys(SOURCES).filter(file => /\.test\.js$/u.test(file)).sort();
  assert.deepEqual(manifest.files.map(entry => entry.file), tests);
});

test('each row names its kind as cell unit, contract, journey or harness, with the rule that chose it [C7]', t => {
  const manifest = generateTestManifest(fixture(t, SOURCES).root, { times: {} });
  const kinds = Object.fromEntries(manifest.files.map(entry => [entry.file, entry.kind]));
  assert.deepEqual(kinds, {
    'apps/cli/journeys/add/main.test.js': 'journey',
    'packages/math/tests/add.test.js': 'cell unit',
    'packages/math/tests/fixtures/git.test.js': 'harness',
    'packages/math/tests/git.test.js': 'contract',
    'packages/math/tests/product-spawn.test.js': 'cell unit',
    'packages/math/tests/store.test.js': 'contract',
    'test/root-pure.test.js': 'cell unit',
    'test/root-spawn.test.js': 'journey',
  });
  for (const entry of manifest.files) {
    assert.ok(TEST_KINDS.includes(entry.kind));
    assert.equal(typeof entry.because, 'string');
  }
});

test('a row records whether the file or a fixture it reaches spawns a process, and product code that spawns does not count [C7]', t => {
  const manifest = generateTestManifest(fixture(t, SOURCES).root, { times: {} });
  const own = row(manifest, 'test/root-spawn.test.js').spawns;
  assert.deepEqual([own.process, own.browser, own.direct, own.via], [true, false, true, []]);
  const fixtureSpawn = row(manifest, 'packages/math/tests/git.test.js').spawns;
  assert.deepEqual([fixtureSpawn.process, fixtureSpawn.direct, fixtureSpawn.via], [true, false, ['packages/math/tests/fixtures/git.js']]);
  assert.equal(row(manifest, 'packages/math/tests/product-spawn.test.js').spawns.process, false);
  assert.equal(row(manifest, 'packages/math/tests/store.test.js').spawns.board, true);
});

test('a row carries the recorded runtime in milliseconds, or null when none was recorded [C7]', t => {
  const manifest = generateTestManifest(fixture(t, SOURCES).root, { times: { 'packages/math/tests/add.test.js': 1234.4, 'gone.test.js': 9 } });
  assert.equal(row(manifest, 'packages/math/tests/add.test.js').cost.ms, 1234);
  assert.equal(row(manifest, 'test/root-pure.test.js').cost.ms, null);
});

test('the command writes the manifest and prints the count per kind [C7]', t => {
  const files = fixture(t, SOURCES), root = files.root;
  files.write('rows.json', '');
  const result = runManifestCommand(['--out', 'rows.json', root], { times: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /8 test files; 3 cell unit, 2 contract, 2 journey, 1 harness/u);
  const written = JSON.parse(files.read('rows.json'));
  assert.equal(written.files.length, 8);
});

test('the command refuses an unknown flag with its usage and writes nothing [C7]', () => {
  const result = runManifestCommand(['--bogus']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: /u);
});

const CITING = {
  'packages/math/tests/one.test.js': `import { test } from "node:test"; test("adds [G1.2, C7]", () => {}); test("again [C7] and [V4]", () => {});`,
  'packages/math/tests/plain.test.js': `import { test } from "node:test"; test("adds with no id", () => {}); test("brackets without an id [draft]", () => {});`,
  'packages/math/tests/quoted.test.js': 'const note = `test("fake [Z9]", () => {})`; // test("comment [Y8]")\nimport { test } from "node:test"; test(`real [A1]`, () => {});',
};

test('each manifest row lists the spec ids its test titles cite, sorted and without repeats [C7]', t => {
  const manifest = generateTestManifest(fixture(t, CITING).root, { times: {} });
  assert.deepEqual(row(manifest, 'packages/math/tests/one.test.js').specs, ['C7', 'G1.2', 'V4']);
  assert.deepEqual(row(manifest, 'packages/math/tests/quoted.test.js').specs, ['A1']);
});

test('a row whose file cites no spec id is marked unproven and one that cites an id is not [C7]', t => {
  const manifest = generateTestManifest(fixture(t, CITING).root, { times: {} });
  assert.equal(row(manifest, 'packages/math/tests/plain.test.js').unproven, true);
  assert.deepEqual(row(manifest, 'packages/math/tests/plain.test.js').specs, []);
  assert.equal(row(manifest, 'packages/math/tests/one.test.js').unproven, false);
});

test('the command prints how many files are unproven [C7]', t => {
  const files = fixture(t, CITING);
  const result = runManifestCommand(['--out', 'rows.json', files.root], { times: {} });
  assert.match(result.stdout, /1 unproven/u);
});
