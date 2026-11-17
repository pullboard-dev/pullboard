/** @pullboard-test-input source-cell packages/landing packages/gate */
/** Landing derives the test registries, so a test move in any lane needs no core-lane patch [C7,V24]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../gate/tests/fixtures/child.js';
import { stageTestRegistries } from '../src/io/registries.js';

const SCRIPT = fileURLToPath(new URL('../../gate/src/io/test/scripts/registries.js', import.meta.url));
const CELLS = 'packages/gate/data/tests/test-cells.json';
const JOURNEYS = 'packages/gate/data/tests/test-journeys.json';
const TIERS = 'packages/gate/data/tests/tiers.json';
const REASON = 'drives the real CLI end to end';
const pretty = value => `${JSON.stringify(value, null, 2)}\n`;

/** A real repo on main holding two root journeys and one view-lane test, all named in the three registries; no registry is touched later. */
function repo(t) {
  const { root } = privateFixtureFiles('landing-registries-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sh = (...args) => runFixtureGit(args, { cwd: root });
  const put = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
  const read = file => JSON.parse(readFileSync(join(root, file), 'utf8'));
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@example.com');
  sh('config', 'user.name', 't');
  put('package.json', '{"type":"module"}\n');
  put('apps/view/index.js', 'export const view = 1;\n');
  for (const file of ['test/moves.test.js', 'test/gone.test.js']) put(file, 'import assert from "node:assert/strict";\nassert.ok(true);\n');
  put('apps/view/tests/keep.test.js', 'import { view } from "../index.js";\nimport assert from "node:assert/strict";\nassert.equal(view, 1);\n');
  put(CELLS, pretty({ journeys: { 'test/moves.test.js': REASON, 'test/gone.test.js': REASON }, pureHelpers: [], leaves: [], findings: {}, rootTests: 2, sealed: [], splits: {} }));
  put(JOURNEYS, pretty({ version: 1, about: 'rows', files: { 'test/moves.test.js': { cells: ['app:view'], reasons: ['runs the CLI'] }, 'test/gone.test.js': { cells: ['app:view'], reasons: ['runs the CLI'] } } }));
  put(TIERS, '{\n  "version": 1,\n  "files": [\n    {"file":"apps/view/tests/keep.test.js","tier":"T1","packages":["apps/view"],"reasons":[]},\n    {"file":"test/gone.test.js","tier":"T3","packages":[],"reasons":["no package: no implementation import"]},\n    {"file":"test/moves.test.js","tier":"T3","packages":[],"reasons":["no package: no implementation import"]}\n  ]\n}\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'base');
  return { root, sh, put, read };
}

/** Do the item on a branch, merge it onto main with --no-ff, and leave HEAD on that merge. */
function land(box, work) {
  box.sh('checkout', '-q', '-b', 'item');
  work();
  box.sh('add', '-A');
  box.sh('commit', '-q', '-m', 'item');
  box.sh('checkout', '-q', 'main');
  box.sh('merge', '-q', '--no-ff', '-m', 'merge item', 'item');
}

test('a fixture view-lane test move lands with no hand edit: every registry row follows the rename and the counts fall [C7,V24]', async t => {
  const box = repo(t);
  land(box, () => {
    mkdirSync(join(box.root, 'apps/view/tests'), { recursive: true });
    box.sh('mv', 'test/moves.test.js', 'apps/view/tests/moves.test.js');
  });
  const staged = await stageTestRegistries(box.root, 'HEAD^1', SCRIPT);
  assert.deepEqual([...staged].sort(), [CELLS, JOURNEYS, TIERS]);
  const cells = box.read(CELLS);
  assert.deepEqual(Object.keys(cells.journeys), ['apps/view/tests/moves.test.js', 'test/gone.test.js'], 'the listing row followed the rename');
  assert.equal(cells.rootTests, 1, 'the root count fell by the move');
  assert.deepEqual(Object.keys(box.read(JOURNEYS).files), ['apps/view/tests/moves.test.js', 'test/gone.test.js'], 'the journey row followed the rename');
  const tiers = box.read(TIERS).files.map(row => row.file);
  assert.deepEqual(tiers, ['apps/view/tests/keep.test.js', 'apps/view/tests/moves.test.js', 'test/gone.test.js'], 'the tier row followed the rename, in sorted order');
  assert.equal(box.sh('diff', '--cached', '--name-only').trim().split('\n').length, 3, 'the three rows are staged for the merge');
});

test('a removed test loses its rows and the derived counts only fall [C7,V24]', async t => {
  const box = repo(t);
  land(box, () => box.sh('rm', '-q', 'test/gone.test.js'));
  await stageTestRegistries(box.root, 'HEAD^1', SCRIPT);
  assert.deepEqual(Object.keys(box.read(CELLS).journeys), ['test/moves.test.js']);
  assert.equal(box.read(CELLS).rootTests, 1);
  assert.deepEqual(Object.keys(box.read(JOURNEYS).files), ['test/moves.test.js']);
  assert.deepEqual(box.read(TIERS).files.map(row => row.file), ['apps/view/tests/keep.test.js', 'test/moves.test.js']);
});

test('a landing that would raise the root count is refused and leaves the registries as they were [C7,V24]', async t => {
  const box = repo(t);
  land(box, () => box.put('test/extra.test.js', 'import assert from "node:assert/strict";\nassert.ok(true);\n'));
  const before = readFileSync(join(box.root, CELLS), 'utf8');
  await assert.rejects(stageTestRegistries(box.root, 'HEAD^1', SCRIPT), /ratchet would rise/u);
  assert.equal(readFileSync(join(box.root, CELLS), 'utf8'), before);
});
