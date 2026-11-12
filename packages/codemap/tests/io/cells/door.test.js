/** @pullboard-test-input packages/codemap/data/plan/cells.json packages/codemap/src/io/cells/scripts/plan.js packages/kernel/browser.js packages/kernel/index.js packages/kernel/src/logic/refused.js */
/** A cell may declare a browser-safe pure door, pure.js, beside its index.js: src/core files only, no node: built-in, no shell [C7,D3]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { fixture } from '../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../landing/tests/fixtures/plan.js';

const BIN = fileURLToPath(new URL('../../../src/io/cells/scripts/plan.js', import.meta.url));
const PURE = 'packages/kernel/browser.js';
const BODY = 'packages/kernel/src/logic/refused.js';

/** Run the real cells plan CLI in the fixture; the moved check's problems come back one per line. */
function plan(root, ...args) {
  const run = spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8' });
  return { status: run.status, problems: run.stderr.split('\n').filter(line => line && !/ExperimentalWarning|--trace-warnings/u.test(line)) };
}

/** Set one key on a cell's plan shard, as a plan edit would. */
function declare(root, cell, key, value) {
  const index = JSON.parse(readFileSync(join(root, 'packages/codemap/data/plan/cells.json'), 'utf8'));
  const file = join(root, index.cells.find(row => row.name === cell).file);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), [key]: value }, null, 1) + '\n');
}

/** Move the fixture's kernel behind index.js and a declared pure.js; an outside shim reaches it through the pure door. */
function movedWithPureDoor(t, { body = 'export class Refused extends Error {}\n', door = "export { Refused } from './src/logic/refused.js';\n", key = PURE } = {}) {
  const project = fixture(t), { root, put } = project;
  put('package.json', JSON.stringify({ type: 'module', bin: 'bin/tool.js' }));
  put(BODY, body);
  put(PURE, door);
  put('packages/kernel/index.js', "export * from './src/logic/refused.js';\n");
  put('src/refused.js', "export { Refused } from '../packages/kernel/browser.js';\n");
  put('bin/tool.js', "import '../packages/kernel/index.js';\nimport '../src/cli.js';\n");
  assert.equal(plan(root, '--write').status, 0);
  declare(root, 'kernel', 'pureDoor', key);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture moved kernel with a pure door');
  return { ...project, moved: () => plan(root, '--moved', 'kernel') };
}

test('a pure.js that imports only src/core files passes, and a shim through it is no front-door bypass [C7,D3]', t => {
  const { moved } = movedWithPureDoor(t);
  const run = moved();
  assert.deepEqual(run.problems, []);
  assert.equal(run.status, 0);
});

test('a pure.js whose closure imports a node: built-in is refused with its reason [C7,D3]', t => {
  const { moved } = movedWithPureDoor(t, { body: "import { createHash } from 'node:crypto';\nexport class Refused extends Error { static id = createHash; }\n" });
  const run = moved();
  assert.equal(run.status, 1);
  assert.ok(run.problems.some(text => text.includes('node:crypto') && text.includes('pure front door')), run.problems.join('\n'));
});

test('a pure.js that re-exports a shell file is refused with its reason [C7,D3]', t => {
  const { moved } = movedWithPureDoor(t, { door: "export { Refused } from './src/logic/refused.js';\nexport { run } from './src/io/process.js';\n" });
  const run = moved();
  assert.equal(run.status, 1);
  assert.ok(run.problems.some(text => text.includes('non-core file') && text.includes('src/io/process.js')), run.problems.join('\n'));
});

test('a pureDoor that is not <cell>/pure.js is refused [C7,D3]', t => {
  const { moved } = movedWithPureDoor(t, { key: 'packages/kernel/other.js' });
  assert.ok(moved().problems.some(text => text.includes('pureDoor must be packages/kernel/browser.js')));
});
