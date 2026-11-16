import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MACHINE_DEFAULTS } from '../../../config/index.js';
import { describeSetting } from '../../../config/index.js';
import { junitCases } from '../../src/logic/junit.js';

const XML = `<?xml version="1.0"?>
<testsuites><testsuite name="s" tests="3">
<testcase name="adds &amp; sums" classname="a"/>
<testcase name="breaks" classname="a"><failure message="x">boom</failure></testcase>
<testcase name="later" classname="a"><skipped/></testcase>
</testsuite></testsuites>`;

test('clause 1: gate.junitReport is a described setting, unset by default [C7]', () => {
  assert.equal(MACHINE_DEFAULTS['gate.junitReport'], null);
  assert.ok(describeSetting('gate.junitReport'));
});

test('clause 2: junitCases returns each case name with pass, fail or skip [C7]', () => {
  const { cases, reason } = junitCases(XML);
  assert.equal(reason, null);
  assert.deepEqual(cases, [
    { name: 'adds & sums', outcome: 'pass' },
    { name: 'breaks', outcome: 'fail' },
    { name: 'later', outcome: 'skip' },
  ]);
});

test('clause 3: damaged XML returns no cases and a coded reason, never a throw [C7]', () => {
  for (const bad of ['', 'not xml', '<testsuite><testcase name="a">', null, undefined, '<testsuites><testsuite><testcase></testcase></testsuite></testsuites>']) {
    const result = junitCases(bad);
    assert.deepEqual(result.cases, []);
    assert.match(result.reason, /^JUNIT_[A-Z]+$/u);
  }
});
