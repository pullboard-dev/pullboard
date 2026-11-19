import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junitCasesAll } from '../../src/logic/junit-merge.js';

const SUITE = (name, body) => `<?xml version="1.0"?><testsuite name="${name}" tests="1">${body}</testsuite>`;
const A = SUITE('A', '<testcase name="a ok" classname="A"/>');
const B = SUITE('B', '<testcase name="b breaks" classname="B"><failure message="x">boom</failure></testcase>');

test('gate.junit-merge.two-reports-in-path-order: clause 1: junitCasesAll returns the cases of two Surefire-shaped reports in path order [C7]', () => {
  const result = junitCasesAll([{ path: 'TEST-B.xml', xml: B }, { path: 'TEST-A.xml', xml: A }]);
  assert.equal(result.reason, null);
  assert.deepEqual(result.unreadable, []);
  assert.deepEqual(result.cases, [{ name: 'a ok', outcome: 'pass' }, { name: 'b breaks', outcome: 'fail' }]);
});

test('gate.junit-merge.damaged-report-named: clause 2: a damaged report among good ones is named in unreadable with its reason and the others still give cases [C7]', () => {
  const result = junitCasesAll([{ path: 'TEST-A.xml', xml: A }, { path: 'TEST-X.xml', xml: 'not xml' }, { path: 'TEST-B.xml', xml: B }]);
  assert.equal(result.reason, null);
  assert.deepEqual(result.unreadable, [{ path: 'TEST-X.xml', reason: 'JUNIT_UNREADABLE' }]);
  assert.deepEqual(result.cases.map(found => found.name), ['a ok', 'b breaks']);
});

test('gate.junit-merge.empty-list-none: clause 3: an empty list gives no cases and reason JUNIT_NONE [C7]', () => {
  assert.deepEqual(junitCasesAll([]), { cases: [], unreadable: [], reason: 'JUNIT_NONE' });
});
