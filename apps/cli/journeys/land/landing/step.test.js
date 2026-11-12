/** The landing gate step runs one group with a configured JUnit report to green [C7,#3974]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { landingStep } from '../../../tests/fixtures/landing/step.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('clause 1: gateGroup runs one group with config.junitReport set and a passing JUnit report to green [C7,#3974]', async t => {
  const step = landingStep(helpers);
  t.after(step.close);
  assert.equal(step.state.config.junitReport, 'junit.xml', 'the landing config names the report');
  const result = await step.run('junit');
  assert.equal(result.isGreen, true, `${step.lines.join('\n')}\n${result.output}`);
  assert.deepEqual(result.failures, []);
  assert.match(readFileSync(`${step.repo}/junit.xml`, 'utf8'), /<testcase [^>]*name="passes \[C7\]"/u, 'the gate wrote the report the config names');
  assert.ok(step.state.gates.get(result.tree), 'the green group is recorded for its tree');
  assert.ok(step.writes.includes('recordLandingBatch'), 'the step saved its gating record');
});
