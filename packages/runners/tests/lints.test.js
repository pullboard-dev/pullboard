/** @pullboard-test-input packages/codemap/src/io/cell/scripts/lints.js packages/codemap/src/io/cells/scripts/plan.js packages/codemap/data/baselines/lints/index.json */
/** @pullboard-test-input ** */
/** Private real-file fixtures prove falling cell debt without moving any repository source [C7,CD64]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CELL_METRICS } from '../../codemap/index.js';
import { cellLintBaseline } from '../../codemap/index.js';
import { cellLintGrowth } from '../../codemap/index.js';
import { lowerCellLintBaseline } from '../../codemap/index.js';
import { runFixtureChild } from '../../gate/tests/fixtures/child.js';
import { importsIn } from '../../gate/index.js';
import { commonJsIn } from '../../gate/index.js';
import { runFixtureGit } from '../../gate/tests/fixtures/child.js';
import { cellLintReport } from '../../codemap/index.js';
import { fixture } from './fixtures/lints-kit.js';
import { provideHelpers } from './fixtures/lints-kit.js';
import { FAMILIES } from './fixtures/lints-kit.js';
import { privateFixtureFiles } from '../../gate/tests/fixtures/child.js';
provideHelpers({ runFixtureGit, runFixtureChild, cellLintReport, importsIn, commonJsIn, CELL_METRICS, privateFixtureFiles });
for (const family of FAMILIES) test(`cell ${family.name} debt refuses a rise and explicitly records a fall [C7,CD64]`, t => {
  const box = fixture(t), before = box.report(), baseline = cellLintBaseline(before);
  family.rise(box);
  const raised = box.report();
  assert.ok(raised.metrics[family.name].count > before.metrics[family.name].count);
  assert.ok(cellLintGrowth(raised, baseline).some(row => row.metric === family.name));
  assert.throws(() => lowerCellLintBaseline(raised, baseline), { code: 'CELL_LINT_ROSE' });
  const acceptedDebt = cellLintBaseline(raised), immutable = JSON.stringify(acceptedDebt);
  family.fall(box);
  const lowered = lowerCellLintBaseline(box.report(), acceptedDebt);
  assert.ok(lowered.metrics[family.name].count < acceptedDebt.metrics[family.name].count);
  assert.equal(JSON.stringify(acceptedDebt), immutable, 'only the returned snapshot changes');
});
