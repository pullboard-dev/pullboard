/** @pullboard-test-input source-tree */
/** Shared real placement fixtures retain native CLI ownership and normal Git hooks [L3,C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computePlan } from '../../../../packages/codemap/index.js';
import { writePlan } from '../../../../packages/codemap/index.js';
import { stalePlanRows } from '../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { unplanned } from '../../../../packages/codemap/src/io/cells/scripts/plan.js';
import { cellLintReport } from '../../../../packages/codemap/index.js';
import { cellLintBaseline } from '../../../../packages/codemap/index.js';
import { writeCellLintBaseline } from '../../../../packages/codemap/index.js';
import { importsIn } from '../../../../packages/gate/index.js';
import { commonJsIn } from '../../../../packages/gate/index.js';
import { publishAcceptedCells } from '../../../../packages/landing/tests/fixtures/plan.js';
import { createE2eHelpers } from './e2e.js';

/** A real committed source checkout with the actual plan, native agents and normal hooks. */
export async function plannedProject(t, { companionLanes = false } = {}) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('node check.cjs');
  if (process.env.PULLBOARD_RUNNER_PRELOAD) box.env.PULLBOARD_RUNNER_PRELOAD = process.env.PULLBOARD_RUNNER_PRELOAD;
  const marker = join(box.dir, 'check-ran');
  writeFileSync(join(box.repo, 'check.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran\\n');\n`);
  writeFileSync(join(box.repo, 'package.json'), '{"type":"module"}\n');
  // This is a small real repository, so its plan and allowances describe its own source.
  const existing = 'src/view/placement-existing.js';
  mkdirSync(join(box.repo, 'src/view'), { recursive: true });
  writeFileSync(join(box.repo, existing), "import { readFileSync } from 'node:fs';\nexport const existingPlacement = readFileSync;\n");
  mkdirSync(join(box.repo, 'packages/codemap/data/plan'), { recursive: true });
  writeFileSync(join(box.repo, 'packages/codemap/data/plan/seed.json'), JSON.stringify({ source: 'placement fixture',
    sha256: 'fixture', order: ['app:view'], cells: { 'app:view': [existing] }, tests: {} }) + '\n');
  const plan = computePlan(box.repo);
  writePlan(box.repo, plan);
  assert.deepEqual(stalePlanRows(box.repo, plan), [], 'every planned source really exists');
  writeCellLintBaseline(box.repo, cellLintBaseline(cellLintReport(box.repo, { importsIn, commonJsIn })), { initialize: true });
  const config = JSON.parse(readFileSync(join(box.repo, 'pullboard.json'), 'utf8'));
  if (companionLanes) {
    config.lanes.view = { owns: ['src/view/'], specs: ['G1'] };
    config.lanes.core = { owns: ['packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan/'], specs: ['G1'] };
  } else config.lanes.web.owns.push('src/', 'packages/codemap/data/plan/cells.json', 'packages/codemap/data/plan/');
  writeFileSync(join(box.repo, 'pullboard.json'), JSON.stringify(config, null, 2) + '\n');
  box.git(box.repo, 'add', '-A');
  assert.deepEqual(unplanned(box.repo, plan), [], 'the fixture commits a complete canonical plan');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: initialize the real placement fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  await publishAcceptedCells(t, box.repo, box.git(box.repo, 'rev-parse', 'main').trim(), box.env.PULLBOARD_MACHINE_HOME);
  return { ...box, marker };
}

/** Keep actual native command failures in every setup assertion. */
export function success(box, cwd, ...args) {
  const run = box.run(cwd, ...args, '--no-next', '--json');
  assert.equal(run.code, 0, run.out + run.err);
  return JSON.parse(run.out);
}

