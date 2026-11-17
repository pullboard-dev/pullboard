/** The JUnit file rows map a language's report case to its repo file with no tool run: a pure table check [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.julia-runtests-file: clause 1: junitFile(julia, row) returns test/runtests.jl for a row with any classname [C7]', () => {
  assert.equal(junitFile('julia', { classname: 'MyPkg' }), 'test/runtests.jl');
});

test('landing.junit-files.julia-no-classname: clause 2: junitFile(julia, row) returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('julia', {}), null);
});
