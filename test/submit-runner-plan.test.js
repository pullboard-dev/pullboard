/** A handoff worker takes the runner's test plan as given and refuses one that does not bind or cover the submit [C7,H24]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptRunnerPlan } from '../apps/cli/src/shell/submit-remote-gate.js';
import { runSubmitGateWithRunnerPlan } from '../apps/cli/src/shell/submit-remote-gate.js';

const main = 'a'.repeat(40);
const source = 'b'.repeat(40);
const analysis = { main, source, plan: { proofFiles: ['test/a.test.js', 'test/b.test.js'] }, admission: { browser: false, gui: false } };

test('a runner plan bound to the pinned commits is used with its admission, so the Mac plans nothing [C7,H24]', () => {
  assert.deepEqual(acceptRunnerPlan(analysis, { main, source, crossRunTests: ['test/b.test.js'] }), { plan: analysis.plan, admission: analysis.admission });
});

test('submit passes the accepted runner plan and admission to runSubmitGate without invoking local planning [C7,H24]', () => {
  let received;
  const runSubmitGate = (root, config, options) => { received = { root, config, options }; return 'gate'; };
  const runnerPlan = acceptRunnerPlan(analysis, { main, source, crossRunTests: ['test/b.test.js'] });
  const result = runSubmitGateWithRunnerPlan(runSubmitGate, '/controller', { affectedTests: true }, runnerPlan, { staticChecked: true });
  assert.equal(result, 'gate');
  assert.deepEqual(received, { root: '/controller', config: { affectedTests: true }, options: {
    staticChecked: true, plan: analysis.plan, admission: analysis.admission,
  } });
});

test('a runner plan whose main or source differs refuses RUNNER_RESULT_INVALID [C7,H24]', () => {
  for (const other of [{ ...analysis, main: 'c'.repeat(40) }, { ...analysis, source: 'c'.repeat(40) }]) {
    assert.throws(() => acceptRunnerPlan(other, { main, source }), { code: 'RUNNER_RESULT_INVALID' });
  }
});

test('a runner plan missing proofFiles or a call-adjacent test refuses instead of running a smaller selection [C7,H24]', () => {
  assert.throws(() => acceptRunnerPlan({ ...analysis, plan: {} }, { main, source }), { code: 'RUNNER_RESULT_INVALID' });
  assert.throws(() => acceptRunnerPlan(analysis, { main, source, crossRunTests: ['test/c.test.js'] }), { code: 'RUNNER_RESULT_INVALID', message: /test\/c\.test\.js/u });
});
