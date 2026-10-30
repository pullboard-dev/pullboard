/** Declared pure entries preserve the moved-cell boundary without importing shell code [C7,D3]. */
import assert from 'node:assert/strict';
import { symlinkSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkMoved } from '../bin/cells-plan.js';
import { computePlan } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';
import { runFixtureChild } from './fixture-child.js';
import { cellLintReport } from '../packages/codemap/index.js';
import { cellLintGrowth } from '../packages/codemap/index.js';
import { planCellLintBaseline } from '../packages/codemap/index.js';
import { readCellLintBaseline } from '../packages/codemap/index.js';
import { writeCellLintBaseline } from '../packages/codemap/index.js';
import { importsIn } from '../src/module-imports.js';
import { commonJsIn } from '../src/module-imports.js';

const BIN = fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));
const CORE = 'packages/kernel/core.js';
const BODY = 'packages/kernel/src/core/refused.js';

/** Move the fixture's real kernel behind both public entries and retain a production index consumer. */
function moved(t) {
  const project = fixture(t), { root, put } = project;
  put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  const plan = computePlan(root), cell = plan.cells.find(row => row.name === 'kernel');
  cell.pureFrontDoor = CORE;
  put(BODY, 'export class Refused extends Error {}\n');
  put(CORE, "export { Refused } from './src/core/refused.js';\n");
  put('packages/kernel/index.js', "export * from './core.js';\n");
  put('src/refused.js', "export { Refused } from '../packages/kernel/core.js';\n");
  put('bin/tool.js', "import '../packages/kernel/index.js';\nimport '../src/cli.js';\n");
  writePlan(root, plan);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture moved kernel with pure public entry');
  return { ...project, plan, cell, problems: () => checkMoved(root, plan, 'kernel') };
}

test('a declared pure front door passes the real moved check while both public entries stay reachable [C7,D3]', t => {
  const { root, put, plan, problems } = moved(t);
  assert.equal(readPlan(root).cells.find(cell => cell.name === 'kernel').pureFrontDoor, CORE);
  assert.deepEqual(problems(), []);
  const result = runFixtureChild(process.execPath, [BIN, '--moved', 'kernel'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  put('src/board.js', "import { Refused } from '../packages/kernel/core.js';\nexport const board = () => Refused;\n");
  assert.deepEqual(checkMoved(root, plan, 'kernel'), [], 'ordinary pure importers may use the declared entry');
  put('src/refused.js', "export { Refused } from '../packages/kernel/index.js';\n");
  assert.deepEqual(problems(), [], 'the original front door remains valid');
});

test('pure metadata never permits a moved leaf bypass or an undeclared second entry [C7,D3]', t => {
  const { put, cell, problems } = moved(t);
  put('src/refused.js', "export { Refused } from '../packages/kernel/src/core/refused.js';\n");
  assert.ok(problems().some(problem => problem.includes('src/refused.js bypasses front door')), problems().join('\n'));
  put('src/refused.js', "export { Refused } from '../packages/kernel/core.js';\n");
  delete cell.pureFrontDoor;
  assert.ok(problems().some(problem => problem.includes('src/refused.js bypasses front door')));
});

test('a pure entry refuses direct and transitive shell or builtin imports naming their source [C7,D3]', t => {
  const { put, problems } = moved(t);
  put('packages/kernel/src/shell/process.js', 'export const launch = true;\n');
  put(CORE, "export * from './src/shell/process.js';\n");
  assert.ok(problems().some(problem => problem.includes(CORE) && problem.includes('src/shell/process.js')));
  put(CORE, "export * from './src/core/refused.js';\n");
  put(BODY, "export { launch } from '../shell/process.js';\n");
  assert.ok(problems().some(problem => problem.includes(BODY) && problem.includes('src/shell/process.js')));
  put(BODY, "import { spawn } from 'node:child_process';\nexport const Refused = spawn;\n");
  assert.ok(problems().some(problem => problem.includes(BODY) && problem.includes('node:child_process')));
  put(CORE, "export { spawn } from 'node:child_process';\n");
  assert.ok(problems().some(problem => problem.includes(CORE) && problem.includes('node:child_process')));
});

test('the index must actually re-export core and opaque loading cannot certify a pure closure [C7,D3]', t => {
  const { put, problems } = moved(t);
  put('packages/kernel/index.js', "import './core.js';\n// export * from './core.js';\nexport const text = \"export * from './core.js';\";\n");
  assert.ok(problems().some(problem => problem.includes('must re-export pure front door')));
  put('packages/kernel/index.js', "export * from './core.js';\n");
  put(BODY, 'export const Refused = () => import(globalThis.target);\n');
  assert.ok(problems().some(problem => problem.includes(BODY) && problem.includes('(computed)')));
  put(BODY, "export const Refused = () => require('child_process');\n");
  assert.ok(problems().some(problem => problem.includes(BODY) && problem.includes('CommonJS')));
});

test('pure front-door validation refuses alternate paths, executable entry code and symbolic source [C7,D3]', t => {
  const { root, put, cell, problems } = moved(t);
  cell.pureFrontDoor = 'packages/kernel/src/core/refused.js';
  assert.ok(problems().some(problem => problem.includes('pureFrontDoor must be packages/kernel/core.js')));
  cell.pureFrontDoor = CORE;
  put(CORE, "import './src/core/refused.js';\nexport const impure = 1;\n");
  assert.ok(problems().some(problem => problem.includes('must only re-export modules')));
  put(CORE, "export * from './src/core/refused.js';\n");
  rmSync(join(root, BODY));
  put('outside.js', 'export const Refused = Error;\n');
  symlinkSync('../../../../outside.js', join(root, BODY));
  assert.ok(problems().some(problem => problem.includes(BODY) && problem.includes('regular pure source')));
});

test('only a declared pure entry fits cell anatomy and a real falling baseline keeps undeclared core stray [C7,D3]', t => {
  const { root, plan, cell, problems } = moved(t);
  const report = () => cellLintReport(root, { importsIn, commonJsIn });
  assert.ok(!report().metrics.strays.findings.some(row => row.key === CORE));
  const baseline = planCellLintBaseline(report());
  writeCellLintBaseline(root, baseline.baseline, { initialize: true });
  assert.deepEqual(problems(), [], 'a declared core entry passes with an actual recorded baseline');
  delete cell.pureFrontDoor;
  writePlan(root, plan);
  assert.ok(report().metrics.strays.findings.some(row => row.key === CORE), 'undeclared core.js remains a stray');
  assert.ok(cellLintGrowth(report(), readCellLintBaseline(root)).some(row => row.metric === 'strays' && row.key === CORE));
  assert.ok(problems().some(problem => problem.includes(`cell lint strays:${CORE}`)), 'the ordinary moved guard still enforces that rise');
  cell.pureFrontDoor = CORE;
  writePlan(root, plan);
  assert.deepEqual(problems(), [], 'restoring the declaration does not need any raised allowance');
});
