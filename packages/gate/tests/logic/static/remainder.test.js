/** Subtracting main's static findings leaves only the item's own [C7,#10448]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remainingFindings } from '../../../src/logic/static/findings.js';

const RULE = 'package tests import packages/gate/tests/fixtures/child.js directly';
const A = { rule: RULE, file: 'packages/git/tests/io/a.test.js' };
const B = { rule: RULE, file: 'packages/git/tests/io/b.test.js' };
const C = { rule: 'no stray logging', file: 'packages/git/src/io/c.js' };

test('gate.logic-static-remainder.only-the-items-own-findings-remain: clause 1: remainingFindings returns the item findings whose rule and file are not in main, in the parser order, and an empty list when main holds all of them [C7,#10448]', () => {
  assert.deepEqual(remainingFindings([A, B, C], [B]), [A, C]);
  assert.deepEqual(remainingFindings([A, B], [B, A, C]), []);
  assert.deepEqual(remainingFindings([A], []), [A]);
  assert.deepEqual(remainingFindings([], [A]), []);
});

test('gate.logic-static-remainder.same-rule-other-file-stays: clause 2: a finding with the same rule on a different file stays in the remainder [C7,#10448]', () => {
  assert.deepEqual(remainingFindings([A], [B]), [A]);
  assert.deepEqual(remainingFindings([{ rule: 'other rule', file: A.file }], [A]), [{ rule: 'other rule', file: A.file }]);
});
