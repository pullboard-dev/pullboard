import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditOnlySplit } from '../packages/landing/src/shell/landing-step-gate.js';

test('landing.auditOnly leaves the named test files out of the per-item gate plan and names them; unset, every file runs [C7]', () => {
  const files = ['test/machine.test.js', 'test/cockpit/live.test.js', 'test/refusal-next-steps.test.js', 'test/cockpit/live.test.js'];
  const split = auditOnlySplit({ landing: { auditOnly: ['test/machine.test.js', 'test/refusal-next-steps.test.js', 'test/not-selected.test.js'] } }, files);
  assert.deepEqual(split.files, ['test/cockpit/live.test.js'], 'only the unlisted file runs, once');
  assert.deepEqual(split.left, ['test/machine.test.js', 'test/refusal-next-steps.test.js'], 'listed files that were selected are named; an unselected one is not');
  const whole = auditOnlySplit({ landing: {} }, files);
  assert.deepEqual(whole.files, ['test/cockpit/live.test.js', 'test/machine.test.js', 'test/refusal-next-steps.test.js']);
  assert.deepEqual(whole.left, []);
  assert.deepEqual(auditOnlySplit({}, []), { files: [], left: [] });
});
