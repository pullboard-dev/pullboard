/** @pullboard-test-input .githooks/pre-commit apps/cli/journeys/resume/board.test.js packages/codemap/data/baselines/layout.json packages/gate/data/baselines/test-waits-baseline.json packages/gate/data/tests/test-fixtures.json */
/** The repository pre-commit hook refuses the gate's test fixture and test-name reds on staged files, with the gate's messages [C7]. */
import {
  after,
  test,
} from 'node:test';
import {
  fixtureProblems,
} from '../../../../packages/gate/src/io/test/fixtures.js';
import {
  testNameProblems,
} from '../../../../packages/gate/src/io/test/names.js';
import {
  copyPackageFiles,
} from '../../../../packages/runners/index.js';

import {
  assertHookRefuses,
  CASES,
  helpers,
  hookedProject,
} from '../../tests/fixtures/fact/precommit-hook.js';

after(() => helpers.cleanup());

test('the real pre-commit hook refuses a raw board and an unnamed test with the gate static stage messages, clause 1 [C7]', () => {
  assertHookRefuses(hookedProject(copyPackageFiles), CASES.slice(2), { fixtureProblems, testNameProblems });
});
