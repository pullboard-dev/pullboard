/** The JUnit file rows map a language's report case to its repo file with no tool run: a pure table check [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junitFile } from '../../src/logic/junit-files.js';

test('landing.junit-files.clojure-namespace-to-file: clause 1: junitFile(clojure, row) turns a namespace classname into a test folder path, dots to folders and hyphens to underscores [C7]', () => {
  assert.equal(junitFile('clojure', { classname: 'my-app.core-test' }), 'test/my_app/core_test.clj');
});

test('landing.junit-files.clojure-no-classname: clause 2: junitFile(clojure, row) returns null for a row without a classname [C7]', () => {
  assert.equal(junitFile('clojure', {}), null);
});
