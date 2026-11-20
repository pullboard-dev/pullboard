/** tapCaseErrors names a red case the way the outcomes record does, with the reporter's escapes undone [C7,#12137]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tapCaseErrors } from '../../../src/logic/runner/output.js';

test('cli.logic-runner-output.tap-escapes-undone: clause 1: tapCaseErrors on a case written with \\# and \\\\ returns the unescaped name [C7]', () => {
  const tap = ['not ok 1 - tap escape [C7,\\#1] a\\\\b', '  ---', '  error: boom', '  ...'].join('\n');
  const rows = tapCaseErrors(tap, '/work');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'tap escape [C7,#1] a\\b');
  assert.equal(rows[0].error, 'boom');
});

test('cli.logic-runner-output.file-path-unchanged: clause 2: tapCaseErrors keeps a file-level failure named by its absolute path [C7]', () => {
  const tap = 'not ok 1 - /abs/path/to/some.test.js # time=3ms';
  assert.deepEqual(tapCaseErrors(tap, '/work').map(row => row.name), ['/abs/path/to/some.test.js']);
});
