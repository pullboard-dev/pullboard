/** The JUnit file rows map a language's report case to its repo file with no tool run: a pure table check [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.nim-test-file: clause 1: junitFile(nim, row) returns the classname with the .nim extension under the tests folder [C7]', () => {
  assert.equal(junitFile('nim', { classname: 'tcalc' }), 'tests/tcalc.nim');
  assert.equal(junitFile('nim', { classname: 'tcalc.nim' }), 'tests/tcalc.nim');
});

test('landing.junit-files.nim-no-classname: clause 2: junitFile(nim, row) returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('nim', {}), null);
});
