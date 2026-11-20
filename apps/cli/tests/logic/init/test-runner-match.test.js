/** @pullboard-test-input source-cell apps/cli */
/** Doctor names a repo whose test runner and affectedTests command disagree [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { affectedRunnerProblems } from '../../../src/logic/init/test-runner-match.js';

const CONFIG = { gate: 'npm test', affectedTests: 'node --test' };

test('cli.logic-init-test-runner-match.jest-with-node-test: clause 1: affectedRunnerProblems returns one AFFECTED_RUNNER_MISMATCH naming jest and the affectedTests command for a jest script with node --test, and none for npx jest or a node --test script [C7]', () => {
  const found = affectedRunnerProblems({ scripts: { test: 'jest' } }, CONFIG);
  assert.equal(found.length, 1);
  assert.equal(found[0].code, 'AFFECTED_RUNNER_MISMATCH');
  assert.match(found[0].message, /jest/u);
  assert.match(found[0].message, /node --test/u);
  assert.match(found[0].next, /pullboard settings affectedTests/u);
  assert.deepEqual(affectedRunnerProblems({ scripts: { test: 'jest' } }, { ...CONFIG, affectedTests: 'npx jest' }), []);
  assert.deepEqual(affectedRunnerProblems({ scripts: { test: 'node --test' } }, CONFIG), []);
});

test('cli.logic-init-test-runner-match.other-runners: clause 2: a vitest or mocha test script with node --test also returns the problem, and a package with no test script returns none [C7]', () => {
  for (const script of ['vitest run', 'mocha --recursive']) assert.equal(affectedRunnerProblems({ scripts: { test: script } }, CONFIG).length, 1, script);
  assert.deepEqual(affectedRunnerProblems({ scripts: {} }, CONFIG), []);
  assert.deepEqual(affectedRunnerProblems(null, CONFIG), []);
});
