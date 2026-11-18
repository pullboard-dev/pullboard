/** @pullboard-test-input packages/gate/src/io/test/manifest.js packages/gate/src/io/test/scripts/manifest.js packages/gate/src/logic/test/manifest.js */
/** The test manifest gives every test file a kind, a recorded cost and what it spawns, derived from source alone [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { generateTestManifest } from '../../../../src/io/test/manifest.js';
import { runManifestCommand } from '../../../../src/io/test/manifest.js';
import { JOURNEY_TAGS } from '../../../../src/logic/test/manifest.js';
import { TEST_KINDS } from '../../../../src/logic/test/manifest.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { runFixtureGit } from '../../../fixtures/child.js';

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

test('gate.io-test-scripts-manifest.every-test-file-has-one-row: every test file has one row, in order, and a fixture that is not a test file has none [C7]', t => {
  const manifest = generateTestManifest(fixture(t, SOURCES).root, { times: {} });
  const tests = Object.keys(SOURCES).filter(file => /\.test\.js$/u.test(file)).sort();
  assert.deepEqual(manifest.files.map(entry => entry.file), tests);
});

test('gate.io-test-scripts-manifest.each-row-names-its-kind-as: each row names its kind as cell unit, contract, journey or harness, with the rule that chose it [C7]', t => {
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

test('gate.io-test-scripts-manifest.a-row-records-whether-the-file: a row records whether the file or a fixture it reaches spawns a process, and product code that spawns does not count [C7]', t => {
  const manifest = generateTestManifest(fixture(t, SOURCES).root, { times: {} });
  const own = row(manifest, 'test/root-spawn.test.js').spawns;
  assert.deepEqual([own.process, own.browser, own.direct, own.via], [true, false, true, []]);
  const fixtureSpawn = row(manifest, 'packages/math/tests/git.test.js').spawns;
  assert.deepEqual([fixtureSpawn.process, fixtureSpawn.direct, fixtureSpawn.via], [true, false, ['packages/math/tests/fixtures/git.js']]);
  assert.equal(row(manifest, 'packages/math/tests/product-spawn.test.js').spawns.process, false);
  assert.equal(row(manifest, 'packages/math/tests/store.test.js').spawns.board, true);
});

test('gate.io-test-scripts-manifest.a-row-carries-the-recorded-runtime: a row carries the recorded runtime in milliseconds, or null when none was recorded [C7]', t => {
  const manifest = generateTestManifest(fixture(t, SOURCES).root, { times: { 'packages/math/tests/add.test.js': 1234.4, 'gone.test.js': 9 } });
  assert.equal(row(manifest, 'packages/math/tests/add.test.js').cost.ms, 1234);
  assert.equal(row(manifest, 'test/root-pure.test.js').cost.ms, null);
});

test('gate.io-test-scripts-manifest.the-command-writes-the-manifest-and: the command writes the manifest and prints the count per kind [C7]', t => {
  const files = fixture(t, SOURCES), root = files.root;
  files.write('rows.json', '');
  const result = runManifestCommand(['--out', 'rows.json', root], { times: {} });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /8 test files; 3 cell unit, 2 contract, 2 journey, 1 harness/u);
  const written = JSON.parse(files.read('rows.json'));
  assert.equal(written.files.length, 8);
});

test('gate.io-test-scripts-manifest.the-command-refuses-an-unknown-flag: the command refuses an unknown flag with its usage and writes nothing [C7]', () => {
  const result = runManifestCommand(['--bogus']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /usage: /u);
});

const CITING = {
  'packages/math/tests/one.test.js': `import { test } from "node:test"; test("adds [G1.2, C7]", () => {}); test("again [C7] and [V4]", () => {});`,
  'packages/math/tests/plain.test.js': `import { test } from "node:test"; test("adds with no id", () => {}); test("brackets without an id [draft]", () => {});`,
  'packages/math/tests/quoted.test.js': 'const note = `test("fake [Z9]", () => {})`; // test("comment [Y8]")\nimport { test } from "node:test"; test(`real [A1]`, () => {});',
};

test('gate.io-test-scripts-manifest.each-manifest-row-lists-the-spec: each manifest row lists the spec ids its test titles cite, sorted and without repeats [C7]', t => {
  const manifest = generateTestManifest(fixture(t, CITING).root, { times: {} });
  assert.deepEqual(row(manifest, 'packages/math/tests/one.test.js').specs, ['C7', 'G1.2', 'V4']);
  assert.deepEqual(row(manifest, 'packages/math/tests/quoted.test.js').specs, ['A1']);
});

test('gate.io-test-scripts-manifest.a-row-whose-file-cites-no: a row whose file cites no spec id is marked unproven and one that cites an id is not [C7]', t => {
  const manifest = generateTestManifest(fixture(t, CITING).root, { times: {} });
  assert.equal(row(manifest, 'packages/math/tests/plain.test.js').unproven, true);
  assert.deepEqual(row(manifest, 'packages/math/tests/plain.test.js').specs, []);
  assert.equal(row(manifest, 'packages/math/tests/one.test.js').unproven, false);
});

test('gate.io-test-scripts-manifest.the-command-prints-how-many-files: the command prints how many files are unproven [C7]', t => {
  const files = fixture(t, CITING);
  const result = runManifestCommand(['--out', 'rows.json', files.root], { times: {} });
  assert.match(result.stdout, /1 unproven/u);
});

const JOURNEYS = {
  'packages/math/index.js': 'export const add = (a, b) => a + b;',
  'packages/math/tests/cell.test.js': 'import { test } from "node:test"; test("adds [C7, D1]", () => {});',
  'apps/cli/journeys/submit/main.test.js': 'import { test } from "node:test"; test("submits [S1]", () => {});',
  'apps/cli/journeys/relay/pair.test.js': 'import { test } from "node:test"; test("pairs [R1]", () => {});',
  'apps/cli/journeys/relay/sync.test.js': 'import { test } from "node:test"; test("syncs [R2]", () => {});',
  'apps/cli/journeys/view/open.test.js': 'import { test } from "node:test"; test("opens [W1]", () => {});',
  'apps/cli/journeys/edges/covered.test.js': 'import { test } from "node:test"; test("covered [C7]", () => {});',
  'apps/cli/journeys/edges/other.test.js': 'import { test } from "node:test"; test("other [C7, Q9]", () => {});',
  'apps/cli/journeys/edges/bare.test.js': 'import { test } from "node:test"; test("bare", () => {});',
};
const tagOf = (manifest, file) => row(manifest, `apps/cli/journeys/${file}.test.js`);

test('gate.io-test-scripts-manifest.each-journey-row-carries-a-tag: each journey row carries a tag of keep, convert or delete with the rule that chose it, and other kinds carry none [C7]', t => {
  const manifest = generateTestManifest(fixture(t, JOURNEYS).root, { times: {} });
  for (const entry of manifest.files.filter(item => item.kind === 'journey')) {
    assert.ok(JOURNEY_TAGS.includes(entry.tag), entry.file);
    assert.equal(typeof entry.tagBecause, 'string');
  }
  assert.equal(row(manifest, 'packages/math/tests/cell.test.js').tag, undefined);
});

test('gate.io-test-scripts-manifest.a-journey-on-a-golden-path: a journey on a golden path is tagged keep, relay and view only for their pairing and opening files [C7]', t => {
  const manifest = generateTestManifest(fixture(t, JOURNEYS).root, { times: {} });
  assert.deepEqual(['submit/main', 'relay/pair', 'view/open'].map(file => tagOf(manifest, file).tag), ['keep', 'keep', 'keep']);
  assert.notEqual(tagOf(manifest, 'relay/sync').tag, 'keep');
  assert.match(tagOf(manifest, 'relay/pair').tagBecause, /relay pair/u);
});

test('gate.io-test-scripts-manifest.a-journey-is-tagged-delete-only: a journey is tagged delete only when a non-journey test cites every spec id it cites, otherwise convert [C7]', t => {
  const manifest = generateTestManifest(fixture(t, JOURNEYS).root, { times: {} });
  assert.equal(tagOf(manifest, 'edges/covered').tag, 'delete');
  assert.equal(tagOf(manifest, 'edges/other').tag, 'convert');
  assert.equal(tagOf(manifest, 'edges/bare').tag, 'convert');
  assert.equal(tagOf(manifest, 'relay/sync').tag, 'convert');
});

test('gate.io-test-scripts-manifest.the-command-prints-the-count-of: the command prints the count of each journey tag [C7]', t => {
  const result = runManifestCommand(['--out', 'rows.json', fixture(t, JOURNEYS).root], { times: {} });
  assert.match(result.stdout, /journey tags: 3 keep, 3 convert, 1 delete/u);
});

test('gate.io-test-scripts-manifest.the-command-prints-a-keep-count: the command prints a keep count of at most 20 however many journeys walk the golden paths [C7]', t => {
  const bases = ['init', 'add', 'next', 'submit', 'verify', 'land', 'release', 'upgrade', 'relay/pair', 'view/open'];
  const sources = Object.fromEntries(bases.flatMap(base => [1, 2, 3].map(n => [`apps/cli/journeys/${base}/j${n}.test.js`, `import { test } from "node:test"; test("walks [P${n}]", () => {});`])));
  const result = runManifestCommand(['--out', 'rows.json', fixture(t, sources).root], { times: {} });
  assert.match(result.stdout, /journey tags: 20 keep, 10 convert, 0 delete/u);
});

test('gate.io-test-scripts-manifest.a-full-regeneration-keeps-the-harness: clause 1: a full regeneration keeps the harness tag on every journey the guard list names [C7]', t => {
  const guards = ['apps/cli/journeys/imports/closure-budget.test.js', 'apps/cli/journeys/inbox/growth.test.js'];
  const manifest = generateTestManifest(fixture(t, { ...SOURCES,
    'packages/gate/data/tests/guards.json': JSON.stringify({ version: 1, files: guards }),
    ...Object.fromEntries(guards.map(file => [file, 'import "../../../../packages/math/index.js";'])) }).root, { times: {} });
  for (const file of guards) {
    assert.equal(row(manifest, file).kind, 'harness', file);
    assert.equal(row(manifest, file).tag, undefined, file);
  }
  assert.equal(row(manifest, 'apps/cli/journeys/add/main.test.js').kind, 'journey', 'a journey the list leaves out stays a journey');
});
