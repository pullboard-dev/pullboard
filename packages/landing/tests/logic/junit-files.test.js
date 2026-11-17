/** @pullboard-test-input source-cell packages/landing */
/** The junit-files adapter table: each language row maps one report case to the repo file a person must open [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.crystal-classname-is-the-spec-file: clause 1: junitFile crystal returns the classname of a row whose classname ends in .cr [C7]', () => {
  assert.equal(junitFile('crystal', { classname: 'spec/calc_spec.cr' }), 'spec/calc_spec.cr');
});

test('landing.junit-files.crystal-non-cr-classname-is-null: clause 2: junitFile crystal returns null for a row whose classname does not end in .cr [C7]', () => {
  assert.equal(junitFile('crystal', { classname: 'Calc' }), null);
  assert.equal(junitFile('crystal', {}), null);
});
