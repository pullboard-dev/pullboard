/** @pullboard-world-pin: the last clause reads the committed bin/checks/cells-edges.json, where each real light door's cold load is recorded. */
/* A light front door may re-export shell modules, but only within its own cold-load budget and without weakening a pure door [C7,D3]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkMoved } from '../../../bin/cells-plan.js';
import { computePlan } from '../../../bin/cells-plan.js';
import { readPlan } from '../../../bin/cells-plan.js';
import { writePlan } from '../../../bin/cells-plan.js';
import { policyProblems } from '../../../bin/cells-submit-checks.js';
import { LIGHT_DOOR_BUDGET_MS } from '../../../bin/checks/cells-edges.js';
import { lightDoorProblems } from '../../../bin/checks/cells-edges.js';
import { coldLoadMs } from '../../../bin/checks/cells-edges.js';
import { lightDoorsOf } from '../../../bin/checks/cells-edges.js';
import { fixture } from '../../../test/cells-plan-fixture.js';
import { git } from '../../../test/cells-plan-fixture.js';
import { runFixtureChild } from '../../../test/fixture-child.js';

const BIN = fileURLToPath(new URL('../../../bin/cells-plan.js', import.meta.url));
const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const CORE = 'packages/kernel/core.js';
const SHELL = 'packages/kernel/src/shell/process.js';

/** Move the fixture's kernel behind a light door whose closure holds a shell module and a node: built-in. */
function moved(t) {
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
  const { root, plan, cell, problems } = moved(t);
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
  const { put, cell, problems } = moved(t);
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
  const { put, problems } = moved(t);
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
  const { root, put, cell } = moved(t);
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
  const { root, put } = moved(t);
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
  const recorded = JSON.parse(readFileSync(new URL('../../../bin/checks/cells-edges.json', import.meta.url), 'utf8')).lightDoors;
  assert.deepEqual(Object.keys(recorded).sort(), lightDoorsOf(REPO).sort());
  for (const [door, ms] of Object.entries(recorded)) assert.ok(Number.isInteger(ms) && ms > 0 && ms <= LIGHT_DOOR_BUDGET_MS, `${door} recorded at ${ms} ms`);
  assert.ok(lightDoorsOf(REPO).includes('packages/gate/core.js'));
  assert.ok(!lightDoorsOf(REPO).some(door => door.includes('/kernel/')), 'a pure door stays off the light list');
});
