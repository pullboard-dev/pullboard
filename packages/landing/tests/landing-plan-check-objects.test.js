/** @pullboard-test-input source-tree */
/** @pullboard-test-loads bin/cells-plan.js */
/** The landing plan check reads the plan and paths from Git objects and adds no worktree [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computePlan } from '../../../bin/cells-plan.js';
import { placePath } from '../../../bin/cells-plan.js';
import { writePlan } from '../../../bin/cells-plan.js';
import { fixture } from '../../../test/cells-plan-fixture.js';
import { git } from '../../../test/cells-plan-fixture.js';
import { requireLandingPlanCheck } from '../index.js';

/** Commit everything now in the fixture and return the new head. */
function commitAll(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD').trim();
}

test('clause 1: the landing plan check refuses an unplaced bin path and passes a placed tree from Git objects with no worktree [C7]', t => {
  const { root, put } = fixture(t);
  writePlan(root, computePlan(root));
  const base = commitAll(root, 'plan the fixture');
  const worktrees = git(root, 'worktree', 'list');
  assert.doesNotThrow(() => requireLandingPlanCheck(root, base), 'a fully placed tree passes');
  put('bin/added-tool.js', 'export const tool = true;\n');
  const bad = commitAll(root, 'add an unplaced bin path');
  assert.throws(() => requireLandingPlanCheck(root, bad), error => error.code === 'LAND_PLAN_UNPLACED' && /bin\/added-tool\.js/u.test(error.message));
  placePath(root, 'bin/added-tool.js', { stay: true });
  const good = commitAll(root, 'place the bin path');
  assert.doesNotThrow(() => requireLandingPlanCheck(root, good), 'the placed commit passes');
  assert.equal(git(root, 'worktree', 'list'), worktrees, 'git worktree list is unchanged');
});
