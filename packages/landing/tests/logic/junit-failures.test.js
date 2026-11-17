/** The JUnit reader names each failing case with its file and message [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junitFailures } from '../../src/logic/junit-failures.js';

const ROOT = '/work/repo';
const XML = `<?xml version="1.0"?>
<testsuites><testsuite name="outer"><testsuite name="inner">
<testcase name="ok" classname="a.B" file="tests/a.py"/>
<testcase name="breaks &amp; burns" classname="a.B" file="tests/a.py"><failure message="assert 1 == 2">trace</failure></testcase>
<testcase name="errs" classname="a.C" file="/work/repo/tests/c.py"><error message="boom"/></testcase>
<testcase name="later" classname="a.B"><skipped/></testcase>
<testcase name="outside" classname="a.D" file="/etc/passwd"><failure message="x"/></testcase>
</testsuite></testsuite></testsuites>`;

test('landing.junit-failures.one-row-per-failed-or-errored: clause 1: one row per failed or errored case with name, classname, file and assertion [C7]', () => {
  const { rows, code } = junitFailures(XML, ROOT);
  assert.equal(code, null);
  assert.deepEqual(rows[0], { name: 'breaks & burns', classname: 'a.B', file: 'tests/a.py', assertion: 'assert 1 == 2\ntrace' });
  assert.deepEqual(rows[1], { name: 'errs', classname: 'a.C', file: 'tests/c.py', assertion: 'boom' });
});

test('landing.junit-failures.the-assertion-is-cut-at-2: clause 1: the assertion is cut at 2 KB with the landing marker [C7]', () => {
  const xml = `<testsuite name="s"><testcase name="big" classname="c"><failure message="${'x'.repeat(3000)}"/></testcase></testsuite>`;
  const [row] = junitFailures(xml, ROOT).rows;
  assert.ok(row.assertion.endsWith('\n[assertion truncated at 2 KB]'));
  assert.equal(row.assertion.length, 2048 + '\n[assertion truncated at 2 KB]'.length);
});

test('landing.junit-failures.passing-and-skipped-cases-give-no: clause 2: passing and skipped cases give no row and nested suites are read [C7]', () => {
  const names = junitFailures(XML, ROOT).rows.map(row => row.name);
  assert.deepEqual(names, ['breaks & burns', 'errs', 'outside']);
});

test('landing.junit-failures.a-file-attribute-outside-root-gives: clause 2: a file attribute outside root gives file null, and a case without one too [C7]', () => {
  const rows = junitFailures(XML, ROOT).rows;
  assert.equal(rows.find(row => row.name === 'outside').file, null);
  const bare = junitFailures('<testsuite name="s"><testcase name="n"><failure message="m"/></testcase></testsuite>', ROOT).rows;
  assert.equal(bare[0].file, null);
});

test('landing.junit-failures.damaged-xml-gives-no-rows-and: clause 3: damaged XML gives no rows and JUNIT_DAMAGED, never a throw [C7]', () => {
  assert.deepEqual(junitFailures('<testsuite name="s"><testcase name="n"><failure/></testcase>', ROOT), { rows: [], code: 'JUNIT_DAMAGED' });
  assert.deepEqual(junitFailures(undefined, ROOT), { rows: [], code: 'JUNIT_UNREADABLE' });
});
