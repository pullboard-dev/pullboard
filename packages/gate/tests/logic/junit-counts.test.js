import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junitCounts } from '../../src/logic/junit-counts.js';

const MIXED = `<?xml version="1.0"?>
<testsuites><testsuite name="s" tests="5">
<testcase name="a" classname="x"/>
<testcase name="b" classname="x"/>
<testcase name="c" classname="x"><failure message="m">boom</failure></testcase>
<testcase name="d" classname="x"><error message="m">crash</error></testcase>
<testcase name="e" classname="x"><skipped/></testcase>
</testsuite></testsuites>`;

test('gate.junit-counts.mixed-report: clause 1: junitCounts counts two passing, one failing, one erroring and one skipped case as pass 2, fail 2, skip 1 [C7]', () => {
  const { pass, fail, skip, reason } = junitCounts(MIXED);
  assert.deepEqual({ pass, fail, skip }, { pass: 2, fail: 2, skip: 1 });
  assert.equal(reason, null);
});

test('gate.junit-counts.damaged-xml: clause 2: damaged or empty XML returns null counts with the junitCases reason code, never a throw [C7]', () => {
  for (const bad of ['', 'not xml', null, undefined, '<testsuite><testcase name="a">']) {
    const out = junitCounts(bad);
    assert.deepEqual([out.pass, out.fail, out.skip], [null, null, null]);
    assert.match(out.reason, /^JUNIT_(UNREADABLE|DAMAGED)$/u);
  }
});

test('gate.junit-counts.zero-cases: clause 3: a report with zero cases returns all three counts 0 [C7]', () => {
  const out = junitCounts('<testsuites><testsuite name="s" tests="0"></testsuite></testsuites>');
  assert.deepEqual({ pass: out.pass, fail: out.fail, skip: out.skip }, { pass: 0, fail: 0, skip: 0 });
  assert.equal(out.reason, null);
});
