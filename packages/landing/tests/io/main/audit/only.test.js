import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditOnlySplit } from '../../../../src/io/step/gate.js';

test('landing.auditOnly leaves the named test files out of the per-item gate plan and names them; unset, every file runs [C7]', () => {
  const files = ['apps/cli/journeys/verify/machine.test.js', 'apps/cli/journeys/claim/live.test.js', 'apps/cli/journeys/submit/steps.test.js', 'apps/cli/journeys/claim/live.test.js'];
  const split = auditOnlySplit({ landing: { auditOnly: ['apps/cli/journeys/verify/machine.test.js', 'apps/cli/journeys/submit/steps.test.js', 'test/not-selected.test.js'] } }, files);
  assert.deepEqual(split.files, ['apps/cli/journeys/claim/live.test.js'], 'only the unlisted file runs, once');
  assert.deepEqual(split.left, ['apps/cli/journeys/submit/steps.test.js', 'apps/cli/journeys/verify/machine.test.js'], 'listed files that were selected are named; an unselected one is not');
  const whole = auditOnlySplit({ landing: {} }, files);
  assert.deepEqual(whole.files, ['apps/cli/journeys/claim/live.test.js', 'apps/cli/journeys/submit/steps.test.js', 'apps/cli/journeys/verify/machine.test.js']);
  assert.deepEqual(whole.left, []);
  assert.deepEqual(auditOnlySplit({}, []), { files: [], left: [] });
});
