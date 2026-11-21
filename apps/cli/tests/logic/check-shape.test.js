/** A check that discards its output or forces its exit to 0 is unsound whatever it measures [C7,#1273]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkHidesResult } from '../../src/logic/check-shape.js';

test('cli.logic-check-shape.flags-hidden-output-or-masked-exit: clause 1: checkHidesResult is true for a check that sends its output to /dev/null or masks its exit, and false for a plain node test-runner command over named test files [C7,#1273]', () => {
  const hiding = [
    'node --test apps/cli/tests/a.test.js > /dev/null',
    'node --test apps/cli/tests/a.test.js >/dev/null 2>&1',
    'node --test apps/cli/tests/a.test.js &>/dev/null',
    'node --test apps/cli/tests/a.test.js 1>>/dev/null',
    'node --test apps/cli/tests/a.test.js || true',
    'node --test apps/cli/tests/a.test.js; true',
    'node --test apps/cli/tests/a.test.js ; exit 0',
    'node --test apps/cli/tests/a.test.js || exit 0',
    'node --test apps/cli/tests/a.test.js || :',
  ];
  for (const command of hiding) assert.equal(checkHidesResult(command), true, command);
  const plain = [
    'node --test apps/cli/tests/a.test.js',
    'node --test apps/cli/tests/a.test.js apps/cli/tests/b.test.js',
    'node --test apps/cli/tests/true.test.js',
    'node --test apps/cli/tests/a.test.js 2>/dev/null',
    '',
    null,
  ];
  for (const command of plain) assert.equal(checkHidesResult(command), false, String(command));
});
