/** @pullboard-test-input source-cell packages/landing */
/** The junit-files adapter table: each language row maps one report case to the repo file a person must open [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.ocaml-classname-is-the-test-file: clause 1: junitFile ocaml returns the lowercased classname with the .ml extension under the test folder [C7]', () => {
  assert.equal(junitFile('ocaml', { classname: 'Calc' }), 'test/calc.ml');
});

test('landing.junit-files.ocaml-no-classname-is-null: clause 2: junitFile ocaml returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('ocaml', {}), null);
  assert.equal(junitFile('ocaml', { classname: '' }), null);
});
