/** Placement reads trunk through the common Git dir or a fetch, and a Git read failure retries instead of refusing [C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { criterionCells } from '../../index.js';
import { criterionSize } from '../../index.js';
import { requirePlannedSource } from '../../index.js';
import { fixture } from '../../../landing/tests/fixtures/plan.js';
import { git } from '../../../landing/tests/fixtures/plan.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';

test('items.criterion.handoff-passes-placement: a handoff whose source lacks the newest trunk commit still passes placement [C7]', t => {
  const { root, put } = fixture(t);
  const handoff = mkdtempSync(join(tmpdir(), 'pullboard-trunk-read-'));
  t.after(() => rmSync(handoff, { recursive: true, force: true }));
  git(handoff, 'clone', '-q', root, 'copy');
  const copy = join(handoff, 'copy');
  const source = git(copy, 'rev-parse', 'HEAD').trim();
  put('src/landed-mid-handoff.js', 'export const landed = true;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main landed mid-handoff');
  const trunk = git(root, 'rev-parse', 'HEAD').trim();
  assert.notEqual(spawnSync('git', ['cat-file', '-e', trunk + '^{commit}'], { cwd: copy }).status, 0, 'the copy really lacks trunk');
  assert.doesNotThrow(() => requirePlannedSource(copy, trunk, source, { deferUnplaced: true }));
});

test('items.criterion.infra-read-not-red: an infrastructure Git read stopping the queued gate is never returned to the builder as red [C7]', () => {
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern=never returned to the builder as red', 'apps/cli/journeys/submit/handoff/red-and-stop.test.js'],
    { cwd: join(import.meta.dirname, '../../../..'), encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'NODE_TEST_CONTEXT')) });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# pass 1$/mu, 'the handoff completion fixture really ran');
});

test('items.io-criterion.cells-from-folders: clause 1: criterionCells lists cells from the package and app folders and criterionSize counts two cells for a criterion naming files in two cell folders, on a temp tree with no plan folder [C7,#2467]', () => {
  const { root, write } = privateFixtureFiles('pullboard-criterion-cells-');
  for (const file of ['packages/alpha/index.js', 'packages/beta/index.js', 'apps/tool/index.js']) write(file, '');
  const cells = criterionCells(root);
  assert.deepEqual(cells.map(cell => [cell.name, cell.root]), [['alpha', 'packages/alpha'], ['beta', 'packages/beta'], ['app:tool', 'apps/tool']]);
  assert.deepEqual(criterionCells(join(root, 'missing')), [], 'a root with no folders lists no cells and refuses nothing');
  const two = criterionSize('1. packages/alpha/src/a.js and packages/beta/src/b.js change [test]', cells);
  assert.deepEqual(two.cells, ['alpha', 'beta']);
  assert.equal(criterionSize('packages/alpha/src/a.js and apps/tool/src/t.js', cells).cells.length, 2);
});
