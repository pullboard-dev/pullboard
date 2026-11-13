/** @pullboard-test-input apps/view/index.js packages/codemap/data/plan/19-items.json packages/codemap/data/plan/cells.json packages/codemap/src/io/cells/scripts/plan.js packages/items/index.js */
/** @pullboard-test-loads packages/codemap/src/io/cells/scripts/plan.js */
/** New source must be placed through the bounded plan writer before native submit runs its check [C7]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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
import {
  readAcceptedCells,
  warmAcceptedCells,
} from '../../../../packages/gate/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

const SOURCE = join(import.meta.dirname, '../../../..');

/** A real committed source checkout with the actual plan, native agents and normal hooks. */
async function plannedProject(t, { companionLanes = false, submitReady = true } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node check.cjs');
  // The runner's own preload is not foreign to a submit child; the env scrub drops its proof and the inventory identity refuses without it.
  if (process.env.PULLBOARD_RUNNER_PRELOAD) box.env.PULLBOARD_RUNNER_PRELOAD = process.env.PULLBOARD_RUNNER_PRELOAD;
  const marker = join(box.dir, 'check-ran');
  writeFileSync(join(box.repo, 'check.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, (process.argv[2] ?? 'proof') + '\\n');\n`);
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  // This is a tiny real project, not a claim that all production source exists in it.
  const plan = readPlan(SOURCE);
  plan.cells = plan.cells.map(cell => ({ ...cell, paths: [], reexports: [], cuts: [], imports: [] }));
  plan.stays = []; plan.retired = []; plan.entries = []; plan.engineStays = [];
  writePlan(box.repo, plan);
  const config = loadConfig(box.repo);
  if (companionLanes) {
    config.lanes.view = { owns: ['src/view/', 'apps/view/'], specs: ['G1'] };
    config.lanes.core = { owns: ['packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan/'], specs: ['G1'] };
  } else config.lanes.web.owns.push('src/', 'packages/items/', 'apps/web/', 'packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan/');
  config.lanes.probe = { owns: ['src/plan-gate-probe.js'], specs: ['G1'] };
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: initialize the real placement fixture');
  writeCellLintBaseline(box.repo, cellLintBaseline(cellLintReport(box.repo, { importsIn, commonJsIn })), { initialize: true });
  box.git(box.repo, 'add', 'packages/codemap/data/baselines/lints');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: capture the tiny project baseline');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  if (submitReady) {
    await publishAcceptedInventory(box);
  }
  return { ...box, marker };
}

/**
 * Publish the accepted inventory of the fixture's main in its private machine home, as the background producer does on a
 * real board (#3533). Why: native submit refuses CELLS_INVENTORY_PENDING until main has one, and a fixture has no producer.
 */
async function publishAcceptedInventory(box) {
  const previous = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_MACHINE_HOME;
  try {
    const main = String(box.git(box.repo, 'rev-parse', 'main')).trim();
    const artifact = await warmAcceptedCells(box.repo, main, { withCheckout: withMainCheckout, withLock: withFileLock, trunk: 'main' });
    assert.equal(artifact.available, true, 'the producer published the fixture main inventory');
    const read = readAcceptedCells(box.web, main);
    assert.equal(read.available, true, `a submit from the seat worktree reads it: ${JSON.stringify(read)}`);
  } finally { if (previous === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = previous; }
}

test('placement rejects unknown cells, duplicate paths, symlinks and out-of-scope paths without rewriting the plan [C7]', async t => {
  const box = await plannedProject(t, { submitReady: false });
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

test('committed plan deletion and malformed shards refuse; an unstaged placement cannot authorize source [C7]', async t => {
  const box = await plannedProject(t, { submitReady: false });
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  assert.throws(() => requirePlannedSource(box.repo, '0'.repeat(40), base), /presence could not be read from Git/);
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  writeFileSync(join(box.repo, 'src/plan-snapshot-only.js'), 'export const value = 3;\n');
  box.git(box.repo, 'add', 'src/plan-snapshot-only.js');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: add unplaced fixture source');
  const head = box.git(box.repo, 'rev-parse', 'HEAD');
  placePath(box.repo, 'src/plan-snapshot-only.js', { cell: 'items' });
  assert.throws(() => requirePlannedSource(box.repo, base, head), /plan-snapshot-only\.js/);
  box.git(box.repo, 'reset', '--hard', head);
  box.git(box.repo, 'rm', 'packages/codemap/data/plan/cells.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: remove fixture plan for the negative control');
  assert.throws(() => requirePlannedSource(box.repo, base, box.git(box.repo, 'rev-parse', 'HEAD')), /restore the committed cells plan/);
  box.git(box.repo, 'reset', '--hard', head);
  writeFileSync(join(box.repo, 'packages/codemap/data/plan/19-items.json'), '{ malformed JSON');
  box.git(box.repo, 'add', 'packages/codemap/data/plan/19-items.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: corrupt only the private plan shard');
  assert.throws(() => requirePlannedSource(box.repo, base, box.git(box.repo, 'rev-parse', 'HEAD')), /valid committed cells plan JSON/);
});

test('removing an existing placement cannot strand its retained committed source [C7]', async t => {
  const box = await plannedProject(t, { submitReady: false });
  mkdirSync(join(box.repo, 'src'), { recursive: true });
  const file = 'src/plan-retained-source.js';
  writeFileSync(join(box.repo, file), 'export const retained = true;\n');
  box.git(box.repo, 'add', file);
  placePath(box.repo, file, { cell: 'items' });
  box.git(box.repo, 'add', 'packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: commit the placed source');
  const base = box.git(box.repo, 'rev-parse', 'HEAD');
  requirePlannedSource(box.repo, base, base);
  const plan = readPlan(box.repo);
  const cell = plan.cells.find(row => row.name === 'items');
  cell.paths = cell.paths.filter(([from]) => from !== file);
  writePlan(box.repo, plan);
  box.git(box.repo, 'add', 'packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: remove only the placement for a negative control');
  assert.throws(() => requirePlannedSource(box.repo, base, box.git(box.repo, 'rev-parse', 'HEAD')), /plan-retained-source\.js/);
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
