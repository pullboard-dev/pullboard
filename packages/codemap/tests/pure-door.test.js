/** A cell may declare a browser-safe pure door, pure.js, beside its index.js: src/core files only, no node: built-in, no shell [C7,D3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkMoved } from '../../../bin/cells-plan.js';
import { computePlan } from '../../../bin/cells-plan.js';
import { writePlan } from '../../../bin/cells-plan.js';
import { fixture } from '../../../test/cells-plan-fixture.js';
import { git } from '../../../test/cells-plan-fixture.js';

const PURE = 'packages/kernel/pure.js';
const BODY = 'packages/kernel/src/core/refused.js';

/** Move the fixture's kernel behind index.js and a declared pure.js; an outside shim reaches it through the pure door. */
function movedWithPureDoor(t, { body = 'export class Refused extends Error {}\n', door = "export { Refused } from './src/core/refused.js';\n" } = {}) {
  const project = fixture(t), { root, put } = project;
  put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  const plan = computePlan(root), cell = plan.cells.find(row => row.name === 'kernel');
  cell.pureDoor = PURE;
  put(BODY, body);
  put(PURE, door);
  put('packages/kernel/index.js', "export * from './src/core/refused.js';\n");
  put('src/refused.js', "export { Refused } from '../packages/kernel/pure.js';\n");
  put('bin/tool.js', "import '../packages/kernel/index.js';\nimport '../src/cli.js';\n");
  writePlan(root, plan);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture moved kernel with a pure door');
  return { ...project, plan, problems: () => checkMoved(root, plan, 'kernel') };
}

test('a pure.js that imports only src/core files passes, and a shim through it is no front-door bypass [C7,D3]', t => {
  const { problems } = movedWithPureDoor(t);
  assert.deepEqual(problems(), []);
});

test('a pure.js whose closure imports a node: built-in is refused with its reason [C7,D3]', t => {
  const { problems } = movedWithPureDoor(t, { body: "import { createHash } from 'node:crypto';\nexport class Refused extends Error { static id = createHash; }\n" });
  assert.ok(problems().some(text => text.includes('node:crypto') && text.includes('pure front door')), problems().join('\n'));
});

test('a pure.js that re-exports a shell file is refused with its reason [C7,D3]', t => {
  const { put, root, plan, problems } = movedWithPureDoor(t);
  put('packages/kernel/src/shell/process.js', 'export const run = () => 1;\n');
  put(PURE, "export { Refused } from './src/core/refused.js';\nexport { run } from './src/shell/process.js';\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'pure door reaches shell');
  assert.ok(problems().some(text => text.includes('non-core file') && text.includes('src/shell/process.js')), problems().join('\n'));
  assert.ok(plan.cells.find(row => row.name === 'kernel').pureDoor === PURE);
});

test('a pureDoor that is not <cell>/pure.js is refused [C7,D3]', t => {
  const { root, put, plan } = movedWithPureDoor(t);
  plan.cells.find(row => row.name === 'kernel').pureDoor = 'packages/kernel/other.js';
  put('packages/kernel/other.js', "export { Refused } from './src/core/refused.js';\n");
  writePlan(root, plan);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'wrong pure door name');
  assert.ok(checkMoved(root, plan, 'kernel').some(text => text.includes('pureDoor must be packages/kernel/pure.js')));
});
