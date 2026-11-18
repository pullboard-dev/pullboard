/** landingFailures names failures from a JUnit report when landing.junitFailures is on [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MACHINE_DEFAULTS } from '../../../../config/index.js';
import { describeSetting } from '../../../../config/index.js';
import { landingFailures } from '../../../src/io/step/failures.js';

const XML = `<?xml version="1.0"?>
<testsuites><testsuite name="s" tests="2">
<testcase name="adds" classname="a" file="tests/a_test.py"/>
<testcase name="breaks" classname="a" file="tests/a_test.py"><failure message="x != y">boom</failure></testcase>
</testsuite></testsuites>`;

const TAP = `TAP version 13
# Subtest: node case
not ok 1 - node case
  ---
  error: 1 !== 0
  location: /repo/test/real.test.js:5
  ...
`;

test('landing.failures-junit.landing-junitfailures-is-a-described-setting: clause 1: landing.junitFailures is a described setting, off by default [C7]', () => {
  assert.equal(MACHINE_DEFAULTS['landing.junitFailures'], false);
  assert.ok(describeSetting('landing.junitFailures'));
});

test('landing.failures-junit.with-the-setting-on-report-failing: clause 2: with the setting on, report failing cases come back as rows; off returns today’s rows [C7]', () => {
  const before = landingFailures(TAP, '/repo');
  const on = landingFailures(TAP, '/repo', { junitFailures: true, junitXml: XML });
  assert.deepEqual(on.slice(0, before.length), before);
  assert.deepEqual(on.slice(before.length), [{ name: 'breaks', file: 'tests/a_test.py', assertion: 'x != y\nboom' }]);
  assert.deepEqual(landingFailures(TAP, '/repo', { junitFailures: false, junitXml: XML }), before);
  assert.deepEqual(landingFailures(TAP, '/repo', { junitXml: XML }), before);
  assert.deepEqual(landingFailures('', '/repo', { junitFailures: true, junitXml: XML }).map(row => row.name), ['breaks']);
  assert.equal(landingFailures('', '/repo', { junitFailures: true, junitXml: XML + XML.slice(XML.indexOf('<testsuites>')) }).length, 1);
});

test('landing.failures-junit.node-tap-and-spec-output-with: clause 3: Node TAP and spec output with no report text gives the same rows with the setting on [C7]', () => {
  const spec = `test at /repo/test/x.test.js:3:1\n✖ spec case (1.2ms)\n  boom\n`;
  for (const output of [TAP, spec, '']) {
    assert.deepEqual(landingFailures(output, '/repo', { junitFailures: true }), landingFailures(output, '/repo'));
    assert.deepEqual(landingFailures(output, '/repo', { junitFailures: true, junitXml: null }), landingFailures(output, '/repo'));
  }
});

const PYTEST = '<testsuites><testsuite name="pytest"><testcase classname="tests.test_math" name="halves"><failure message="assert 1 == 2">boom</failure></testcase></testsuite></testsuites>';

test('landing.failures-junit.junitlanguage-names-the-file-of-a-report-case: clause 1: landingFailures with junitLanguage python names a pytest case with no file attribute by the python row of junitFile [C7]', () => {
  const rows = landingFailures('', '/repo', { junitFailures: true, junitXml: PYTEST, junitLanguage: 'python' });
  assert.deepEqual(rows, [{ name: 'halves', file: 'tests/test_math.py', assertion: 'assert 1 == 2\nboom' }]);
});

test('landing.failures-junit.no-junitlanguage-leaves-the-file-null: clause 2: with no junitLanguage the same call leaves the file null as before [C7]', () => {
  assert.deepEqual(landingFailures('', '/repo', { junitFailures: true, junitXml: PYTEST }).map(row => row.file), [null]);
  assert.deepEqual(landingFailures('', '/repo', { junitFailures: true, junitXml: PYTEST, junitLanguage: 'cobol' }).map(row => row.file), [null]);
});
