/** First pure-entry declarations retain immutable accepted cell authority [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, git } from './cells-plan-fixture.js';
import { computePlan, writePlan } from '../bin/cells-plan.js';
import { requireSubmitCells } from '../bin/cells-submit-checks.js';
import { cellLintReport, cellLintBaseline, writeCellLintBaseline } from '../packages/codemap/index.js';
import { withMainCheckout } from '../src/main-red.js';
import { importsIn, commonJsIn } from '../src/module-imports.js';
import { withImportParseCache } from '../src/module-import-cache.js';
import { foreignNodeOptions } from '../src/test-isolation.js';

/** Pin an actual moved package and its accepted baseline before adding entry metadata. */
function accepted(t, declared = false) {
  const box = fixture(t), plan = computePlan(box.root), cell = plan.cells.find(row => row.name === 'kernel');
  box.put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  box.put('packages/kernel/src/core/refused.js', 'export class Refused extends Error {}\n');
  box.put('packages/kernel/core.js', "export { Refused } from './src/core/refused.js';\n");
  box.put('packages/kernel/index.js', "export * from './core.js';\n");
  box.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  box.put('apps/cli/index.js', "import '../../src/cli.js';\n");
  box.put('bin/tool.js', "import '../packages/kernel/index.js';\nimport '../src/cli.js';\n");
  box.put('path-map.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/core/refused.js' }));
  if (declared) cell.pureFrontDoor = 'packages/kernel/core.js';
  writePlan(box.root, plan);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'accepted package source');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'seed baseline metadata inventory');
  // Capture the baseline's own real tracked files before pinning accepted main.
  const complete = cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn }));
  rmSync(join(box.root, 'bin/cell-lint-baselines'), { recursive: true });
  writeCellLintBaseline(box.root, complete, { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'accepted complete package baseline');
  return { ...box, plan, cell, main: git(box.root, 'rev-parse', 'HEAD').trim() };
}

/** Inspect exact committed candidate bytes through the real immutable controller. */
function inspect(box) {
  writePlan(box.root, box.plan);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'candidate entry policy');
  return requireSubmitCells(box.root, box.main, git(box.root, 'rev-parse', 'HEAD').trim(),
    { item_frozen: JSON.stringify({ criterion: 'Add a valid pureFrontDoor without changing accepted identity.' }) },
    { withMainCheckout, parsers: { importsIn, commonJsIn }, withImportParseCache,
      readCutItems: () => [], cacheEligible: () => !foreignNodeOptions(process.env.NODE_OPTIONS) });
}

test('submit accepts the first valid canonical pure front door [C7,D3,CD64]', async t => {
  const box = accepted(t);
  box.cell.pureFrontDoor = 'packages/kernel/core.js';
  assert.deepEqual((await inspect(box)).problems, []);
});

test('submit rejects a first impure or noncanonical declaration [C7,D3,CD64]', async t => {
  const box = accepted(t);
  box.cell.pureFrontDoor = 'packages/kernel/alternate.js';
  await assert.rejects(inspect(box), /pureFrontDoor must be packages\/kernel\/core.js/u);
  box.cell.pureFrontDoor = 'packages/kernel/core.js';
  box.put('packages/kernel/src/core/refused.js', "import 'node:fs'; export class Refused extends Error {}\n");
  await assert.rejects(inspect(box), /reaches node:fs through pure front door/u);
});

test('submit refuses changing or removing an accepted pure front door [C7,D3,CD64]', async t => {
  const box = accepted(t, true);
  box.cell.pureFrontDoor = 'packages/kernel/alternate.js';
  await assert.rejects(inspect(box), /accepted cell kernel identity\/order\/front door changed/u);
  delete box.cell.pureFrontDoor;
  await assert.rejects(inspect(box), /accepted cell kernel identity\/order\/front door changed/u);
});

test('first pure entry cannot change accepted order root or ordinary front door [C7,D3,CD64]', async t => {
  const box = accepted(t);
  box.cell.pureFrontDoor = 'packages/kernel/core.js';
  for (const [key, value] of [['order', 99], ['root', 'packages/other'], ['frontDoor', 'packages/kernel/other.js']]) {
    const original = box.cell[key];
    box.cell[key] = value;
    await assert.rejects(inspect(box), /accepted cell kernel identity\/order\/front door changed/u);
    box.cell[key] = original;
  }
});
