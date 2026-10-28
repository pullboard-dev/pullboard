/** @pullboard-test-input source-tree bin/cells-plan.json bin/cells-plan/** */
/** An outside change to gate, landing or merge code is sensitive, and the list is the plan-derived set [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPlan } from '../bin/cells-plan.js';
import { OUTSIDE_SENSITIVE_PATHS } from '../src/outside-sensitive.js';
import { SENSITIVE_CELLS } from '../src/outside-sensitive.js';
import { outsideSensitivePaths } from '../src/outside-sensitive.js';
import { outsideSensitivity } from '../src/outside-sensitive.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const PLAN = readPlan(ROOT);
const mainPolicy = () => ({ version: 1, commit: 'HEAD', config: {} });

/** Independent expectation: every directory and file the committed plan puts under a sensitive cell. */
function expectedPlanPaths(plan) {
  const expected = new Set();
  for (const name of SENSITIVE_CELLS) {
    const cell = plan.cells.find(row => row.name === name);
    assert.ok(cell, `the committed plan has no ${name} cell; a rename would drop its sensitivity`);
    if (cell.root) expected.add(`${cell.root}/`);
    expected.add(`src/${name}/`);
    for (const [from, to] of cell.paths) expected.add(from).add(to);
  }
  return expected;
}

test('the sensitive list is the fixed boundaries plus exactly the plan-derived cell paths [C7]', () => {
  const list = outsideSensitivePaths(PLAN);
  const fixed = new Set(OUTSIDE_SENSITIVE_PATHS);
  const derived = list.filter(path => !fixed.has(path));
  assert.deepEqual([...new Set(derived)].sort(), [...expectedPlanPaths(PLAN)].sort());
  assert.deepEqual([...list.slice(0, OUTSIDE_SENSITIVE_PATHS.length)], [...OUTSIDE_SENSITIVE_PATHS]);
});

test('gate and landing cells are named by the committed plan, so a move cannot drop them [C7]', () => {
  for (const name of ['gate', 'landing']) assert.ok(SENSITIVE_CELLS.includes(name));
  for (const name of SENSITIVE_CELLS) assert.ok(PLAN.cells.some(cell => cell.name === name), `${name} is a plan cell`);
});

test('an outside change touching src/gate/ or src/landing/ is marked sensitive [C7]', () => {
  const paths = ['src/gate/anything.js', 'src/landing/anything.js', 'src/gate-submit.js', 'packages/gate/src/shell/gate-submit.js', 'packages/landing/src/shell/computed-conflict-return.js'];
  const reasons = outsideSensitivity(ROOT, 'HEAD', 'HEAD', paths, { mainPolicy });
  for (const path of paths) {
    assert.ok(reasons.some(reason => reason.path === path && reason.rule === 'declared-sensitive-path'), `${path} is marked sensitive`);
  }
});
