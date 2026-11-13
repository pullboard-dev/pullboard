/** First pure-entry declarations retain immutable accepted cell authority [C7,D3,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../packages/landing/tests/fixtures/plan.js';
import { computePlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { requireSubmitCells } from '../../index.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { withMainCheckout } from '../../../../packages/landing/index.js';
import { warmAcceptedCells } from '../../../../packages/gate/index.js';
import { withFileLock } from '../../../../packages/outbox/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { withImportParseCache } from '../../../../packages/gate/index.js';
import { foreignNodeOptions } from '../../../../packages/gate/index.js';

/** Pin an actual moved package and its accepted baseline before adding entry metadata. */
function accepted(t, declared = false) {
  const box = fixture(t), plan = computePlan(box.root), cell = plan.cells.find(row => row.name === 'kernel');
  box.put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  box.put('packages/kernel/src/logic/refused.js', 'export class Refused extends Error {}\n');
  box.put('packages/kernel/light.js', "export { Refused } from './src/logic/refused.js';\n");
  box.put('packages/kernel/index.js', "export * from './light.js';\n");
  box.put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  box.put('apps/cli/index.js', "import '../../src/cli.js';\n");
  box.put('bin/tool.js', "import '../packages/kernel/index.js';\nimport '../src/cli.js';\n");
  box.put('path-map.json', JSON.stringify({ 'src/refused.js': 'packages/kernel/src/logic/refused.js' }));
  if (declared) cell.pureFrontDoor = 'packages/kernel/light.js';
  writePlan(box.root, plan);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'accepted package source');
  writeCellLintBaseline(box.root, cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn })), { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'seed baseline metadata inventory');
  // Capture the baseline's own real tracked files before pinning accepted main.
  const complete = cellLintBaseline(cellLintReport(box.root, { importsIn, commonJsIn }));
  rmSync(join(box.root, 'packages/codemap/data/baselines/lints'), { recursive: true });
  writeCellLintBaseline(box.root, complete, { initialize: true });
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '--allow-empty', '-m', 'accepted complete package baseline');
  return { ...box, plan, cell, main: git(box.root, 'rev-parse', 'HEAD').trim() };
}

/** Inspect exact committed candidate bytes through the real immutable controller. */
async function inspect(box) {
  // The accepted-main inventory is produced by a background job on a runner; the test produces its own (a test never waits on one).
  await warmAcceptedCells(box.root, box.main, { withCheckout: withMainCheckout, withLock: withFileLock });
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
  box.cell.pureFrontDoor = 'packages/kernel/light.js';
  assert.deepEqual((await inspect(box)).problems, []);
});

test('submit rejects a first impure or noncanonical declaration [C7,D3,CD64]', async t => {
  const box = accepted(t);
  box.cell.pureFrontDoor = 'packages/kernel/alternate.js';
  await assert.rejects(inspect(box), /pureFrontDoor must be packages\/kernel\/light.js/u);
  box.cell.pureFrontDoor = 'packages/kernel/light.js';
  box.put('packages/kernel/src/logic/refused.js', "import 'node:fs'; export class Refused extends Error {}\n");
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
  box.cell.pureFrontDoor = 'packages/kernel/light.js';
  for (const [key, value] of [['order', 99], ['root', 'packages/other'], ['frontDoor', 'packages/kernel/other.js']]) {
    const original = box.cell[key];
    box.cell[key] = value;
    await assert.rejects(inspect(box), /accepted cell kernel identity\/order\/front door changed/u);
    box.cell[key] = original;
  }
});
