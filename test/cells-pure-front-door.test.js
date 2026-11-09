/** @pullboard-world-pin: the last clause reads the committed bin/checks/cells-edges.json, where each real light door's cold load is recorded. */
/* Declared pure entries preserve the moved-cell boundary without importing shell code; a light front door may re-export shell modules within its cold-load budget [C7,D3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkMoved } from '../bin/cells-plan.js';
import { computePlan } from '../bin/cells-plan.js';
import { readPlan } from '../bin/cells-plan.js';
import { writePlan } from '../bin/cells-plan.js';
import { policyProblems } from '../bin/cells-submit-checks.js';
import { LIGHT_DOOR_BUDGET_MS } from '../bin/checks/cells-edges.js';
import { lightDoorProblems } from '../bin/checks/cells-edges.js';
import { coldLoadMs } from '../bin/checks/cells-edges.js';
import { lightDoorsOf } from '../bin/checks/cells-edges.js';
import { fixture } from './cells-plan-fixture.js';
import { git } from './cells-plan-fixture.js';
import { runFixtureChild } from './fixture-child.js';
import { cellLintReport } from '../packages/codemap/index.js';
import { cellLintGrowth } from '../packages/codemap/index.js';
import { planCellLintBaseline } from '../packages/codemap/index.js';
import { readCellLintBaseline } from '../packages/codemap/index.js';
import { writeCellLintBaseline } from '../packages/codemap/index.js';
import { importsIn } from '../packages/gate/index.js';
import { commonJsIn } from '../packages/gate/index.js';

const BIN = fileURLToPath(new URL('../bin/cells-plan.js', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));
const CORE = 'packages/kernel/core.js';
const SHELL = 'packages/kernel/src/shell/process.js';
const BODY = 'packages/kernel/src/core/refused.js';

/** Move the fixture's real kernel behind both public entries and retain a production index consumer. */
function movedPure(t) {
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
  const { root, put, plan, problems } = movedPure(t);
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
  const { put, cell, problems } = movedPure(t);
  put('src/refused.js', "export { Refused } from '../packages/kernel/src/core/refused.js';\n");
  assert.ok(problems().some(problem => problem.includes('src/refused.js bypasses front door')), problems().join('\n'));
  put('src/refused.js', "export { Refused } from '../packages/kernel/core.js';\n");
  delete cell.pureFrontDoor;
  assert.ok(problems().some(problem => problem.includes('src/refused.js bypasses front door')));
});

test('a pure entry refuses direct and transitive shell or builtin imports naming their source [C7,D3]', t => {
  const { put, problems } = movedPure(t);
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
  const { put, problems } = movedPure(t);
  put('packages/kernel/index.js', "import './core.js';\n// export * from './core.js';\nexport const text = \"export * from './core.js';\";\n");
  assert.ok(problems().some(problem => problem.includes('must re-export pure front door')));
  put('packages/kernel/index.js', "export * from './core.js';\n");
  put(BODY, 'export const Refused = () => import(globalThis.target);\n');
  assert.ok(problems().some(problem => problem.includes(BODY) && problem.includes('(computed)')));
  put(BODY, "export const Refused = () => require('child_process');\n");
  assert.ok(problems().some(problem => problem.includes(BODY) && problem.includes('CommonJS')));
});

test('pure front-door validation refuses alternate paths, executable entry code and symbolic source [C7,D3]', t => {
  const { root, put, cell, problems } = movedPure(t);
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
  const { root, plan, cell, problems, put } = movedPure(t);
  put('bin/cells-plan/path-map/kernel.json', JSON.stringify({ 'src/refused.js': BODY }));
  git(root, 'add', 'bin/cells-plan/path-map/kernel.json');
  git(root, 'commit', '-q', '-m', 'fixture records the completed kernel move');
  const report = () => cellLintReport(root, { importsIn, commonJsIn });
  assert.equal(report().transition.active, false, 'a recorded real move leaves the legacy advisory transition');
  assert.ok(!report().metrics.strays.findings.some(row => row.key === CORE));
  const baseline = planCellLintBaseline(report());
  writeCellLintBaseline(root, baseline.baseline, { initialize: true });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture records its cell lint baseline'); // A real baseline is committed before items compare with it.
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

/** Move the fixture's kernel behind a light door whose closure holds a shell module and a node: built-in. */
function movedLight(t) {
  const project = fixture(t), { root, put } = project;
  put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  const plan = computePlan(root), cell = plan.cells.find(row => row.name === 'kernel');
  cell.lightFrontDoor = CORE;
  put('packages/kernel/src/core/refused.js', 'export class Refused extends Error {}\n');
  put(SHELL, "import { join } from 'node:path';\nexport const launch = join('a', 'b');\n");
  put(CORE, "export { Refused } from './src/core/refused.js';\nexport { launch } from './src/shell/process.js';\n");
  put('packages/kernel/index.js', "export * from './core.js';\n");
  put('src/refused.js', "export { Refused } from '../packages/kernel/core.js';\n");
  put('bin/tool.js', "import '../packages/kernel/index.js';\nimport '../src/cli.js';\n");
  writePlan(root, plan);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture moved kernel with light public entry');
  return { ...project, plan, cell, problems: () => checkMoved(root, plan, 'kernel') };
}

test('a declared light front door passes the moved check with shell re-exports and a front-door shim [C7,D3]', t => {
  const { root, plan, cell, problems } = movedLight(t);
  assert.equal(readPlan(root).cells.find(row => row.name === 'kernel').lightFrontDoor, CORE);
  assert.deepEqual(problems(), []);
  const result = runFixtureChild(process.execPath, [BIN, '--moved', 'kernel'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  cell.pureFrontDoor = CORE;
  delete cell.lightFrontDoor;
  assert.ok(checkMoved(root, plan, 'kernel').some(problem => problem.includes('reaches non-core file') && problem.includes(SHELL)),
    'the same closure declared pure is still refused');
});

test('a light door is never pure, has one canonical path and re-exports through the index [C7,D3]', t => {
  const { put, cell, problems } = movedLight(t);
  cell.pureFrontDoor = CORE;
  assert.ok(problems().some(problem => problem.includes('lightFrontDoor and pureFrontDoor are mutually exclusive')));
  delete cell.pureFrontDoor;
  cell.lightFrontDoor = 'packages/kernel/src/core/refused.js';
  assert.ok(problems().some(problem => problem.includes('lightFrontDoor must be packages/kernel/core.js')));
  cell.lightFrontDoor = CORE;
  put('packages/kernel/index.js', "import './core.js';\nexport const text = \"export * from './core.js';\";\n");
  assert.ok(problems().some(problem => problem.includes('must re-export light front door')));
});

test('a light closure refuses bare packages and opaque loading but allows node: built-ins [C7,D3]', t => {
  const { put, problems } = movedLight(t);
  put(SHELL, "import { x } from 'left-pad';\nexport const launch = x;\n");
  assert.ok(problems().some(problem => problem.includes(SHELL) && problem.includes('left-pad')));
  put(SHELL, 'export const launch = () => import(globalThis.target);\n');
  assert.ok(problems().some(problem => problem.includes(SHELL) && problem.includes('(computed)')));
  put(SHELL, "export const launch = () => require('child_process');\n");
  assert.ok(problems().some(problem => problem.includes(SHELL) && problem.includes('CommonJS')));
  put(SHELL, "import { spawn } from 'node:child_process';\nexport const launch = spawn;\n");
  assert.deepEqual(problems(), []);
});

test('an accepted pure door may become light on the same path, never another path [C7,D3]', t => {
  const { root, put, cell } = movedLight(t);
  const light = readPlan(root), pure = structuredClone(light);
  const pureCell = pure.cells.find(row => row.name === 'kernel');
  pureCell.pureFrontDoor = CORE;
  delete pureCell.lightFrontDoor;
  put(SHELL, 'export const launch = 1;\n');
  const check = (before, after) => policyProblems(before, after, new Map(), new Map(), root, root);
  assert.ok(!check(pure, light).some(problem => problem.includes('identity/order/front door changed')), check(pure, light).join('\n'));
  cell.lightFrontDoor = 'packages/kernel/other.js';
  const other = structuredClone(light);
  other.cells.find(row => row.name === 'kernel').lightFrontDoor = 'packages/kernel/other.js';
  assert.ok(check(pure, other).some(problem => problem.includes('identity/order/front door changed')));
  assert.ok(check(light, pure).some(problem => problem.includes('identity/order/front door changed')), 'an accepted light door cannot go back');
});

test('the edge check refuses a light door whose cold load passes its budget [C7]', async t => {
  const { root, put } = movedLight(t);
  const quiet = () => lightDoorProblems(root);
  assert.deepEqual(lightDoorsOf(root), [CORE]);
  assert.deepEqual(await quiet(), []);
  put(SHELL, 'let total = 0;\nfor (let i = 0; i < 4e8; i += 1) total += i;\nexport const launch = total;\n');
  assert.ok(await coldLoadMs(root, CORE) > LIGHT_DOOR_BUDGET_MS);
  const [problem, ...rest] = await quiet();
  assert.deepEqual(rest, []);
  assert.match(problem.text, /light door cold load \d+ ms exceeds its 100 ms budget/u);
});

test('every real light door is recorded in the edge ceilings within its budget [C7]', () => {
  const recorded = JSON.parse(readFileSync(new URL('../bin/checks/cells-edges.json', import.meta.url), 'utf8')).lightDoors;
  assert.deepEqual(Object.keys(recorded).sort(), lightDoorsOf(REPO).sort());
  for (const [door, ms] of Object.entries(recorded)) assert.ok(Number.isInteger(ms) && ms > 0 && ms <= LIGHT_DOOR_BUDGET_MS, `${door} recorded at ${ms} ms`);
  assert.ok(lightDoorsOf(REPO).includes('packages/gate/core.js'));
  assert.ok(!lightDoorsOf(REPO).some(door => door.includes('/kernel/')), 'a pure door stays off the light list');
});
