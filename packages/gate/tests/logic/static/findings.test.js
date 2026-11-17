/** The static output parser names each finding's rule and file [C7,#3854]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { staticFindings } from '../../../src/logic/static/findings.js';

/** Rows in the shape the static guard prints them (copied from real red runs). */
const TWO_FILES_ONE_RULE = [
  'packages/git/tests/io/review-folder.test.js:7: package tests import packages/gate/tests/fixtures/child.js directly',
  'packages/git/tests/io/other.test.js:12: package tests import packages/gate/tests/fixtures/child.js directly',
].join('\n');

test('clause 1: two files failing one rule give a sorted list of {rule, file}, and a green run gives an empty list [C7,#3854]', () => {
  const rule = 'package tests import packages/gate/tests/fixtures/child.js directly';
  assert.deepEqual(staticFindings(TWO_FILES_ONE_RULE), [
    { rule, file: 'packages/git/tests/io/other.test.js' },
    { rule, file: 'packages/git/tests/io/review-folder.test.js' },
  ]);
  assert.deepEqual(staticFindings('static style, prose declarations, clock budgets and doctrine hold\n'), []);
  assert.deepEqual(staticFindings(''), []);
});

test('clause 1: a ratchet row keeps its rule when the counts and the line move, and spec ids are not part of the rule [C7,#3854]', () => {
  const before = staticFindings('STATIC_RED apps/view:1: 65 tests outside cell apps/view read its files by path, over the ratchet of 64; import its front door instead of reading its source');
  const after = staticFindings('apps/view:9: 66 tests outside cell apps/view read its files by path, over the ratchet of 65; import its front door instead of reading its source');
  assert.deepEqual(before, after);
  const [tagged] = staticFindings('packages/git/src/io/review-folder.js:31: runs a git fetch outside the one entry point [C7]');
  assert.equal(tagged.rule, 'runs a git fetch outside the one entry point');
});
