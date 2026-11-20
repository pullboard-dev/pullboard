/** @pullboard-test-input packages/gate/src/io/run/tests.js */
/** The gate's TAP reader unescapes Node's \# and \\ in a failing case name, so the red is accounted [C7]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { accountedFailures } from '../light.js';
import { tapFailures } from '../light.js';
import { formatTestOutcomes } from '../src/io/test/outcomes.js';
import { privateFixtureFiles } from './fixtures/child.js';
import { runFocusedRunner } from './fixtures/focused-runner.js';

const NAME = 'tap escape [C7,#1] a\\b';
const RUN = '0123abcd-0000-4000-8000-000000000001';

/** The outcome run id the runner printed, which the gate passes to the parser as the stage's testOutcomeRunId. */
function outcomeRunId(output) {
  return /^# pullboard test outcomes \{"version":1,"id":"([^"]+)"/mu.exec(output)?.[1] ?? null;
}

test('gate.light.tap-escaped-name: clause 1: a TAP case name with an escaped hash and backslash reads back unescaped and matches its outcome [C7]', () => {
  const output = ['TAP version 13',
    `# Subtest: tap escape [C7,\\#1] a\\\\b`,
    `not ok 1 - tap escape [C7,\\#1] a\\\\b`,
    '  ---',
    '  duration_ms: 1',
    "  location: '/r/tests/x.test.js:3:1'",
    "  failureType: 'testCodeFailure'",
    '  ...',
    '1..1', '# tests 1', '# pass 0', '# fail 1',
    formatTestOutcomes(RUN, [{ file: 'tests/x.test.js', name: NAME, passed: false, skipped: false, failure: 'assertion' }]).trimEnd(),
    ''].join('\n');
  assert.deepEqual(tapFailures(output, '/r', { outcomeRunId: RUN, nativeLeaves: true }), [{ name: NAME, file: 'tests/x.test.js' }]);
});

test('gate.light.tap-escaped-real-run: clause 2: a real runner red on a title with a hash and a backslash is accounted under the unescaped name [C7]', () => {
  const files = privateFixtureFiles('pullboard-tap-escape-');
  const { root } = files;
  files.write('package.json', JSON.stringify({ type: 'module' }));
  files.write('escape.test.js', `import { test } from 'node:test';
import assert from 'node:assert/strict';
test(${JSON.stringify(NAME)}, () => { assert.equal(1, 2); });
`);
  const result = runFocusedRunner(root, [join(root, 'escape.test.js')], { ...process.env });
  const output = result.text;
  assert.equal(result.status, 1, output);
  assert.match(output, /not ok \d+ - tap escape \[C7,\\#1\] a\\\\b/u, 'Node writes the name escaped');
  const gate = { isGreen: false, stages: [{ status: 1, output, testOutcomeRunId: outcomeRunId(output) }] };
  const rows = accountedFailures(gate, root, { nativeLeaves: true });
  assert.ok(rows, `the gate accounted no failures for the runner's output:\n${output}`);
  assert.deepEqual(rows.map(row => row.name), [NAME]);
});
