/** @pullboard-test-input source-tree packages/codemap/data/plan/cells.json packages/codemap/data/plan/** */
/** An outside change to gate, landing or merge code is sensitive, and the list is the plan-derived set [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readPlan } from '../../../../codemap/index.js';
import { OUTSIDE_SENSITIVE_PATHS } from '../../../index.js';
import { SENSITIVE_CELLS } from '../../../index.js';
import { outsideSensitivePaths } from '../../../index.js';
import { outsideSensitivity } from '../../../index.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
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
  const fixed = OUTSIDE_SENSITIVE_PATHS.length;
  assert.deepEqual(list.slice(0, fixed), [...OUTSIDE_SENSITIVE_PATHS]);
  assert.deepEqual(list.slice(fixed).sort(), [...expectedPlanPaths(PLAN)].sort());
});

test('gate and landing cells are named by the committed plan, so a move cannot drop them [C7]', () => {
  for (const name of ['gate', 'landing']) assert.ok(SENSITIVE_CELLS.includes(name));
  for (const name of SENSITIVE_CELLS) assert.ok(PLAN.cells.some(cell => cell.name === name), `${name} is a plan cell`);
});

test('an outside change touching src/gate/ or src/landing/ is marked sensitive [C7]', () => {
  const paths = ['src/gate/anything.js', 'src/landing/anything.js', 'src/gate-submit.js', 'packages/gate/src/io/submit.js', 'packages/landing/src/io/computed/conflict/return.js'];
  const reasons = outsideSensitivity(ROOT, 'HEAD', 'HEAD', paths, { mainPolicy });
  for (const path of paths) {
    assert.ok(reasons.some(reason => reason.path === path && reason.rule === 'declared-sensitive-path'), `${path} is marked sensitive`);
  }
});
