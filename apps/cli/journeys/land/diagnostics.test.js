import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingFailures } from '../../../../packages/landing/index.js';
import { landingSubject } from '../../../../packages/landing/index.js';
/** Exercise landing diagnostics and bisect adoption against real private Git worktrees [B3,R3]. */
test('landing diagnostics retain unknown failures and merge subjects obey typed 72-character headers [B3,R3]', () => {
  const root = '/private/landing';
  const failures = landingFailures(`not ok 1 - located failure\n  location: ${root}/test/one.test.js:3:4\nnot ok 2 - unknown failure\n`, root);
  assert.deepEqual(failures, [{ name: 'located failure', file: 'test/one.test.js' }, { name: 'unknown failure', file: null }]);
  // Node 24 node --test reports with spec by default: its failing-tests summary names each file and test (#1071).
  const spec = landingFailures(`\u2716 red one (1.2ms)\n\u2716 failing tests:\n\ntest at web/red.test.js:6:1\n\u2716 red one (1.2ms)\n  AssertionError\n\ntest at /elsewhere/x.test.js:1:1\n\u2716 outside (3ms)\n`, root);
  assert.deepEqual(spec, [{ name: 'red one', file: 'web/red.test.js', assertion: 'AssertionError' }, { name: 'outside', file: null }], 'spec failures keep their file and assertion, and an outside path is unknown');
  // The title keeps priority up to the room its first row needs; the rows fill what is left (RFC 0005).
  const subject = landingSubject({ item_id: 91, item_title: 'A VERY LONG TITLE '.repeat(10), item_spec_ids: 'B3,R3' });
  assert.equal(subject, 'chore(merge): a very long title a very long title a very long [B3,R3]');
  assert.ok(subject.length <= 72);
});
