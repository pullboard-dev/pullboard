/**
 * A submit gate red only in cases its main base also fails goes to review, never back to its builder, through the
 * gate runner's real output: apps/cli/src/io/run/tests.js ends every stage with its phase line on stderr, after TAP's final count
 * (#3794). A case main passes keeps the gate red [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tapFailures } from '../../../../packages/gate/light.js';

const PHASES = 'run-tests: phases selection 0.1s, admission 0.0s, tests 0.4s, cleanup 0.0s, total 0.5s';

/** One failing case's TAP as node --test prints it, followed by the given trailer lines. */
function tap(...trailer) {
  return ['TAP version 13', 'not ok 1 - shared failure [G1]', '  ---', "  location: '/repo/test/inherited.test.js:3:1'",
    "  failureType: 'testCodeFailure'", "  error: 'Expected values to be strictly equal'", '  ...', '1..1', '# tests 1', '# fail 1',
    '# cancelled 0', ...trailer, ''].join('\n');
}

test('clause 1: the gate runner\'s phase line after TAP\'s final count leaves the failures accounted, and any other trailer still does not [C7]', () => {
  assert.deepEqual(tapFailures(tap(PHASES), '/repo'), [{ name: 'shared failure [G1]', file: 'test/inherited.test.js' }]);
  assert.equal(tapFailures(tap('something else failed'), '/repo'), null, 'an unknown line after the count is still unaccounted');
  assert.equal(tapFailures(tap(`${PHASES} and more`), '/repo'), null, 'only the exact phase line is the runner\'s');
});

test('clause 1: Node\'s runtime warning lines after TAP\'s final count leave the failures accounted, and a look-alike does not [C7]', () => {
  const warning = ['(node:4242) ExperimentalWarning: SQLite is an experimental feature and might change at any time', '(Use `node --trace-warnings ...` to show where the warning was created)'];
  assert.deepEqual(tapFailures(tap(...warning), '/repo'), [{ name: 'shared failure [G1]', file: 'test/inherited.test.js' }]);
  assert.equal(tapFailures(tap('(node:4242) something failed'), '/repo'), null, 'only a Warning line is node\'s');
  assert.equal(tapFailures(tap('(Use `node --trace-warnings ...` to show where the warning was created) and more'), '/repo'), null);
});
