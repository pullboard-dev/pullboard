/** With add.warnUnnamedTest on, the bar lint warns about a [test] clause no gate run can tick; it never refuses [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintBar } from '../../src/logic/bar-lint.js';

const UNNAMED = '1. a test shows the handler returns the canonical result [test]';
const NAMED = '1. packages/web/tests/handler.test.js shows the handler returns the canonical result [test]';
const codes = (bar, options) => lintBar(bar, options).warnings.map(warning => warning.code);

test('clause 1: setting on, a [test] clause naming no file with no Test: line gets BAR_TEST_UNNAMED, a warning and no refusal [C7]', () => {
  const result = lintBar(UNNAMED, { warnUnnamedTest: true, brief: 'Build the handler.' });
  assert.deepEqual(result.warnings.map(warning => warning.code), ['BAR_TEST_UNNAMED']);
  assert.equal(result.warnings[0].clause, 1);
  assert.match(result.warnings[0].message, /next: name the test file in clause 1 or end the brief with "Test: <path>"/u);
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.fix, []);
});

test('clause 2: no warning when the clause names a file, the brief ends with a Test: line, or the setting is off [C7]', () => {
  assert.deepEqual(codes(NAMED, { warnUnnamedTest: true, brief: 'Build the handler.' }), []);
  assert.deepEqual(codes(UNNAMED, { warnUnnamedTest: true, brief: 'Build the handler.\n\nTest: packages/web/tests/handler.test.js.' }), []);
  assert.deepEqual(codes(UNNAMED, { warnUnnamedTest: false, brief: 'Build the handler.' }), []);
  assert.deepEqual(codes(UNNAMED, { brief: 'Build the handler.' }), []);
  assert.deepEqual(codes('1. the handler prints OK [command]', { warnUnnamedTest: true, brief: '' }), []);
});
