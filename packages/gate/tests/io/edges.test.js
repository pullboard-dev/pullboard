/** The light-door cold-load check judges a door against main measured in the same run, so machine load alone never refuses a change [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { privateFixtureFiles } from '../fixtures/child.js';
import { edgesExitStatus } from '../fixtures/edges-cli.js';
import { LIGHT_DOOR_BUDGET_MS } from '../../src/io/edges.js';
import { lightDoorProblems } from '../../src/io/edges.js';
import { lightDoorRefused } from '../../src/io/edges.js';

const DOOR = 'packages/kernel/light.js';
const made = [];
after(() => { for (const dir of made) rmSync(dir, { recursive: true, force: true }); });

const FAST = 'export const launch = 1;\n';
const SLOW = 'let total = 0;\nfor (let i = 0; i < 4e8; i += 1) total += i;\nexport const launch = total;\n';

/** A tree with one cell whose declared light door holds `body`. */
function tree(body) {
  const { root, write: put } = privateFixtureFiles('edges-door-');
  made.push(root);
  put('packages/codemap/data/plan/cells.json', JSON.stringify({ cells: [{ file: 'packages/codemap/data/plan/cells/kernel.json' }] }));
  put('packages/codemap/data/plan/cells/kernel.json', JSON.stringify({ name: 'kernel', lightFrontDoor: DOOR }));
  put(DOOR, body);
  return root;
}

test('gate.io-edges.a-door-within-the-budget-passes: a door within the budget passes whatever main measures [C7]', () => {
  assert.equal(lightDoorRefused(60, undefined), false);
  assert.equal(lightDoorRefused(60, 20), false);
});

test('gate.io-edges.without-a-main-reading-the-absolute: without a main reading the absolute budget still refuses an over-budget door [C7]', () => {
  assert.equal(lightDoorRefused(LIGHT_DOOR_BUDGET_MS + 1, undefined), true);
  assert.equal(lightDoorRefused(LIGHT_DOOR_BUDGET_MS, undefined), false);
});

test('gate.io-edges.on-a-loaded-machine-where-main: on a loaded machine where main reads over the budget, a candidate level with main passes [C7]', () => {
  assert.equal(lightDoorRefused(104, 105), false);
  assert.equal(lightDoorRefused(160, 150), false);
  assert.equal(lightDoorRefused(300, 280), false);
});

test('gate.io-edges.a-candidate-over-the-budget-while: a candidate over the budget while main is under it is refused [C7]', () => {
  assert.equal(lightDoorRefused(140, 60), true);
  assert.equal(lightDoorRefused(105, 90), true);
});

test('gate.io-edges.a-candidate-slower-than-main-by: a candidate slower than main by more than the margin is refused even when main is over the budget [C7]', () => {
  assert.equal(lightDoorRefused(400, 150), true);
  assert.equal(lightDoorRefused(110, 105), false);
});

test('gate.io-edges.a-few-ms-of-noise-around: a few ms of noise around the budget does not refuse when main sits at the budget [C7]', () => {
  assert.equal(lightDoorRefused(104, 99), false);
  assert.equal(lightDoorRefused(104, 100), false);
});

test('gate.io-edges.a-slow-door-that-main-also: a slow door that main also has is not the candidate\'s doing; a slow door main lacks is refused [C7]', async () => {
  const slowMain = tree(SLOW), slowCandidate = tree(SLOW), fastMain = tree(FAST);
  assert.deepEqual(await lightDoorProblems(slowCandidate, { mainRoot: slowMain }), []);
  const [problem, ...rest] = await lightDoorProblems(slowCandidate, { mainRoot: fastMain });
  assert.deepEqual(rest, []);
  assert.match(problem.text, /light door cold load \d+ ms exceeds its 100 ms budget, and main measures \d+ ms beside it/u);
});

test('gate.io-edges.with-no-main-tree-the-absolute: with no main tree the absolute budget alone refuses a slow door [C7]', async () => {
  const [problem] = await lightDoorProblems(tree(SLOW), { mainRoot: null });
  assert.match(problem.text, /exceeds its 100 ms budget;/u);
  assert.deepEqual(await lightDoorProblems(tree(FAST), { mainRoot: null }), []);
});

test('gate.io-edges.a-wall-only-slowdown-passes-and-cpu-growth-fails: clause 1: a door that only waits 400 ms in a top-level await is not refused, and a door that burns CPU is refused, both against the unchanged 100 ms budget [C7]', async () => {
  assert.equal(LIGHT_DOOR_BUDGET_MS, 100);
  const WAITS = 'await new Promise(done => setTimeout(done, 400));\nexport const launch = 1;\n';
  assert.deepEqual(await lightDoorProblems(tree(WAITS), { mainRoot: null }), []);
  const [problem] = await lightDoorProblems(tree(SLOW), { mainRoot: null });
  assert.match(problem.text, /light door cold load \d+ ms exceeds its 100 ms budget/u);
});

test('gate.io-edges.no-cold-load-flag-skips-doors: clause 1: edges.js exits 1 on a CPU-burning light door by default, 0 with --no-cold-load, and still exits 1 on an edge violation with the flag [C7]', () => {
  const run = edgesExitStatus;
  const slow = tree(SLOW);
  assert.equal(run(slow), 1, 'by default the slow door is refused');
  assert.equal(run(slow, '--no-cold-load'), 0, 'the flag skips the cold-load measure');
  const { root: bad, write: put } = privateFixtureFiles('edges-door-');
  made.push(bad);
  put('packages/codemap/data/plan/cells.json', JSON.stringify({ cells: [{ file: 'packages/codemap/data/plan/cells/kernel.json' }], allowedEdges: ['kernel->nowhere'] }));
  put('packages/codemap/data/plan/cells/kernel.json', JSON.stringify({ name: 'kernel' }));
  put('packages/kernel/index.js', FAST);
  assert.equal(run(bad, '--no-cold-load'), 1, 'an edge violation is still refused with the flag');
});
