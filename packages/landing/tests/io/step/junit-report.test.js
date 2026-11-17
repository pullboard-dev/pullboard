/** @pullboard-test-input source-cell packages/landing */
/** gate.junitReport may name a folder of reports: landing reads every *.xml in it and names the unreadable ones [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { landingFailures } from '../../../src/io/step/failures.js';
import { readJunitReport } from '../../../src/io/step/junit-report.js';

const SUITE = (name, body) => `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${name}" tests="1">${body}</testsuite>`;
const A = SUITE('com.example.AddTest', '<testcase name="adds" classname="com.example.AddTest"/>');
const B = SUITE('com.example.HalfTest', '<testcase name="halves" classname="com.example.HalfTest" file="src/test/HalfTest.java"><failure message="expected 2 but was 1">boom</failure></testcase>');
const C = SUITE('com.example.SubTest', '<testcase name="subtracts" classname="com.example.SubTest" file="src/test/SubTest.java"><failure message="expected 0 but was 1">bang</failure></testcase>');

/** A checkout with a reports folder holding the given files, removed after `run`. */
function withReports(files, run) {
  const fixture = privateFixtureFiles('pullboard-junit-folder-');
  try {
    for (const [name, text] of Object.entries(files)) fixture.write(`reports/${name}`, text);
    return run(fixture.root);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); }
}

test('landing.junit-report-folder.two-reports-both-failures: clause 1: a folder of two Surefire-shaped TEST-*.xml files hands landingFailures the failing cases of both [C7]', () => {
  withReports({ 'TEST-B.xml': B, 'TEST-C.xml': C, 'TEST-A.xml': A }, root => {
    const report = readJunitReport(root, 'reports');
    assert.equal(report.code, null);
    assert.deepEqual(report.unreadable, []);
    const rows = landingFailures('', root, { junitFailures: true, junitXml: report.xml });
    assert.deepEqual(rows.map(row => row.name), ['halves', 'subtracts']);
    assert.deepEqual(rows.map(row => row.file), ['src/test/HalfTest.java', 'src/test/SubTest.java']);
  });
});

test('landing.junit-report-folder.damaged-file-named: clause 2: a damaged file in the folder is named and the good files still count [C7]', () => {
  withReports({ 'TEST-A.xml': A, 'TEST-B.xml': B, 'TEST-X.xml': 'not xml', 'notes.txt': 'ignored' }, root => {
    const report = readJunitReport(root, 'reports');
    assert.equal(report.code, null);
    assert.deepEqual(report.unreadable, ['TEST-X.xml']);
    assert.deepEqual(landingFailures('', root, { junitFailures: true, junitXml: report.xml }).map(row => row.name), ['halves']);
  });
  withReports({ 'TEST-X.xml': 'not xml' }, root => {
    assert.deepEqual(readJunitReport(root, 'reports'), { xml: null, code: 'JUNIT_UNREADABLE', unreadable: ['TEST-X.xml'] });
  });
});

test('landing.junit-report-folder.single-file-unchanged: clause 3: gate.junitReport naming one file behaves exactly as today [C7]', () => {
  withReports({ 'one.xml': B }, root => {
    assert.deepEqual(readJunitReport(root, 'reports/one.xml'), { xml: B, code: null });
    assert.deepEqual(readJunitReport(root, 'reports/missing.xml'), { xml: null, code: 'JUNIT_UNREADABLE' });
    assert.deepEqual(readJunitReport(root, '../outside.xml'), { xml: null, code: 'JUNIT_UNREADABLE' });
  });
  withReports({ 'cut.xml': '<testsuite name="s"><testcase name="a">' }, root => {
    assert.deepEqual(readJunitReport(root, 'reports/cut.xml'), { xml: null, code: 'JUNIT_DAMAGED' });
  });
});
