/** @pullboard-test-input packages/codemap/data/plan/19-items.json packages/codemap/data/plan/cells.json packages/codemap/src/io/cells/scripts/plan.js packages/items/index.js */
/** @pullboard-test-loads packages/codemap/src/io/cells/scripts/plan.js */
/** The bounded plan writer places source safely; submit no longer refuses unplaced source (#6365) [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  readPlan,
  writePlan,
  placePath,
} from '../../../../packages/codemap/index.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { loadConfig } from '../../../../packages/config/index.js';
import { requirePlannedSource } from '../../../../packages/items/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const SOURCE = join(import.meta.dirname, '../../../..');

/** A real committed source checkout with the actual plan. */
async function plannedProject(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  // This is a tiny real project, not a claim that all production source exists in it.
  const plan = readPlan(SOURCE);
  plan.cells = plan.cells.map(cell => ({ ...cell, paths: [], reexports: [], cuts: [], imports: [] }));
  plan.stays = []; plan.retired = []; plan.entries = []; plan.engineStays = [];
  writePlan(box.repo, plan);
  const config = loadConfig(box.repo);
  config.lanes.web.owns.push('src/', 'packages/items/', 'apps/web/', 'packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan/');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: initialize the real placement fixture');
  writeCellLintBaseline(box.repo, cellLintBaseline(cellLintReport(box.repo, { importsIn, commonJsIn })), { initialize: true });
  box.git(box.repo, 'add', 'packages/codemap/data/baselines/lints');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: capture the tiny project baseline');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  return box;
}

test('placement rejects unknown cells, duplicate paths, symlinks and out-of-scope paths without rewriting the plan [C7]', async t => {
  const box = await plannedProject(t);
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/plan-place-negative.js'), 'export const value = 2;\n');
  box.git(box.repo, 'add', 'src/plan-place-negative.js');
  const before = readPlan(box.repo);
  assert.throws(() => placePath(box.repo, 'src/plan-place-negative.js', { cell: 'not-a-cell' }), /existing cell/);
  assert.throws(() => placePath(box.repo, '../src/plan-place-negative.js', { cell: 'items' }), /in-scope/);
  assert.throws(() => placePath(box.repo, 'docs/not-source.md', { stay: true }), /in-scope/);
  assert.deepEqual(readPlan(box.repo), before);
  symlinkSync('plan-place-negative.js', join(box.repo, 'src/plan-place-link.js'));
  box.git(box.repo, 'add', 'src/plan-place-link.js');
  assert.throws(() => placePath(box.repo, 'src/plan-place-link.js', { cell: 'items' }), /regular source/);
  placePath(box.repo, 'src/plan-place-negative.js', { stay: true });
  assert.deepEqual(readPlan(box.repo).stays.slice(0, before.stays.length), before.stays);
  assert.throws(() => placePath(box.repo, 'src/plan-place-negative.js', { stay: true }), /already placed/);
  writeFileSync(join(box.repo, 'src/plan-place-pure.js'), 'export const value = 3;\n');
  box.git(box.repo, 'add', 'src/plan-place-pure.js');
  placePath(box.repo, 'src/plan-place-pure.js', { cell: 'items', part: 'core' });
  assert.deepEqual(readPlan(box.repo).cells.find(row => row.name === 'items').paths.find(([from]) => from === 'src/plan-place-pure.js'),
    ['src/plan-place-pure.js', 'packages/items/src/logic/plan-place-pure.js', 'rule']);
});

test('ordinary repositories without an accepted cells plan retain their source contract [C7]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/ordinary-project.js'), 'export const ordinary = true;\n');
  box.git(box.repo, 'add', 'src/ordinary-project.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: keep ordinary project source independent of cells');
  assert.equal(existsSync(join(box.repo, 'packages/codemap/data/plan/cells.json')), false);
  requirePlannedSource(box.repo, base, box.git(box.repo, 'rev-parse', 'HEAD'));
});
