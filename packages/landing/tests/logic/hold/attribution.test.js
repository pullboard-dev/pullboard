import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingFailures } from '../../../src/io/step/failures.js';

/** One red case as the TAP reporter prints it from a runner whose job checkout sits under the given root. */
function redFrom(runnerRoot) {
  return [
    'TAP version 13',
    '# Subtest: [A5] schema, versions, event kinds and event detail fields match live behavior',
    'not ok 9 - [A5] schema, versions, event kinds and event detail fields match live behavior',
    '  ---',
    '  duration_ms: 114.001042',
    "  type: 'test'",
    `  location: '${runnerRoot}/jobs/94af11af-de08-4c3e-9ff0-6a6bb20e2ef1-cGEMRl/checkout/docs/formats.test.js:774:1'`,
    "  failureType: 'testCodeFailure'",
    "  error: 'distinct-clause rejects retain the existing strong-route notice'",
    "  code: 'ERR_ASSERTION'",
    '  ...',
    '1..9',
  ].join('\n');
}

test('a red reported from any runner root, dotted or not, keeps its repo file, so the red path can compare and charge it [C7]', () => {
  for (const root of ['/Users/example/.pullboard-runner', '/Users/person/pullboard-runner']) {
    const failures = landingFailures(redFrom(root), '/elsewhere');
    assert.equal(failures.length, 1, root);
    assert.equal(failures[0].file, 'docs/formats.test.js', `file attributed from ${root}`);
    assert.match(failures[0].name, /^\[A5\] schema/u);
  }
});
