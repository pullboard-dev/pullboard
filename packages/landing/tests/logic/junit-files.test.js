/** @pullboard-test-input source-cell packages/landing */
/** The junit-files adapter table: each language row maps one report case to the repo file a person must open [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.zig-classname-is-the-file: clause 1: junitFile zig returns the classname of a row whose classname ends in .zig [C7]', () => {
  assert.equal(junitFile('zig', { classname: 'src/calc.zig' }), 'src/calc.zig');
  assert.equal(junitFile('zig', { classname: 'src/calc.cpp' }), null);
});

test('landing.junit-files.zig-no-classname-is-null: clause 2: junitFile zig returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('zig', {}), null);
  assert.equal(junitFile('zig', { classname: '' }), null);
});
