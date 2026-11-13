/** The cells plan reader reads only tracked source, so an ignored scratch file cannot break it [C7,D3]. */
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkCuts } from '../../../../../packages/codemap/index.js';
import { cellInventory } from '../../../../../packages/codemap/index.js';
import { commonJsIn } from '../../../../../packages/codemap/index.js';
import { computePlan } from '../../../../../packages/codemap/index.js';
import { importCuts } from '../../../../../packages/codemap/index.js';
import { importsIn } from '../../../../../packages/codemap/index.js';
import { writePlan } from '../../../../../packages/codemap/index.js';
import { stalePlanRows } from '../../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { unplanned } from '../../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { fixture } from '../../../../../packages/landing/tests/fixtures/plan.js';
import { git } from '../../../../../packages/landing/tests/fixtures/plan.js';

const PARSERS = { importsIn, commonJsIn };

/** A fixture with its plan committed, so the cuts and the check start green. */
function committed(t) {
  const box = fixture(t);
  writePlan(box.root, computePlan(box.root));
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'frozen fixture plan');
  return box;
}

/** The two commands' readers: the cut check for one cell and the unplanned and stale-row check. */
function runBoth(root) {
  const plan = computePlan(root);
  const inventory = cellInventory(root, PARSERS);
  return { cuts: checkCuts(root, plan, importCuts(plan)[0].cell, { inventory }), check: [...unplanned(root, plan, inventory), ...stalePlanRows(root, plan)] };
}

test('an ignored, non-module script leaves --cuts and --check green [C7,D3]', t => {
  const { root, put } = committed(t);
  const before = runBoth(root);
  appendFileSync(join(root, '.git', 'info', 'exclude'), 'src/scratch/\n');
  put('src/scratch/probe.js', "const fs = require('fs');\nmodule.exports = fs.readFileSync(__filename);\n");
  assert.ok(!cellInventory(root, PARSERS).files.has('src/scratch/probe.js'), 'the ignored script is never read');
  assert.deepEqual(runBoth(root), before, 'both commands answer as they did before the script existed');
});

test('a tracked file that does not parse as an ES module fails and names its path [C7,D3]', t => {
  const { root, put } = committed(t);
  put('src/broken.js', 'export const = ;\n');
  git(root, 'add', '-A');
  assert.throws(() => cellInventory(root, PARSERS), /src\/broken\.js/u);
});
