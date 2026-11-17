/** failureSignatures signs JUnit failure rows when landing.junitSignatures is on, so main-red excusal works for any runner [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MACHINE_DEFAULTS } from '../../../../config/index.js';
import { describeSetting } from '../../../../config/index.js';
import { failureSignatures } from '../../../index.js';
import { matchingMainFailures } from '../../../index.js';
import { cachedFailureSignatures } from '../../../index.js';
import { MAIN_FAILURE_SIGNATURE_VERSION } from '../../../index.js';

const ROOT = '/work/repo';
const FILE = 'tests/a_test.py';
const xml = (...names) => `<testsuites><testsuite name="s">${names.map(name =>
  `<testcase name="${name}" classname="a" file="${FILE}"><failure message="x != y">boom</failure></testcase>`).join('')}</testsuite></testsuites>`;
const run = (...names) => ({ stages: [], isGreen: false, executionRoot: ROOT, executionRunner: true, junitXml: xml(...names) });
const mainOutcome = rows => ({ file: FILE, result: 'red', failures: rows, signatureVersion: MAIN_FAILURE_SIGNATURE_VERSION });
const comparison = rows => ({ main: 'abc', files: [mainOutcome(rows)] });

test('landing.junit-matches.landing-junitsignatures-is-a-described-setting: clause 1: landing.junitSignatures is a described setting, off by default [C7]', () => {
  assert.equal(MACHINE_DEFAULTS['landing.junitSignatures'], false);
  assert.ok(describeSetting('landing.junitSignatures'));
});

test('landing.junit-matches.with-it-on-a-junit-run: clause 2: with it on, a JUnit run returns signed rows and a case main also fails is matched [C7]', () => {
  const main = failureSignatures(run('breaks'), ROOT, { junitSignatures: true });
  const candidate = failureSignatures(run('breaks'), '/other/checkout', { junitSignatures: true });
  assert.equal(main.length, 1);
  assert.match(main[0].signature, /^[0-9a-f]{64}$/u);
  assert.deepEqual(candidate, main);
  assert.ok(cachedFailureSignatures(mainOutcome(main), FILE), 'cached main rows read back');
  assert.equal(matchingMainFailures(candidate, comparison(main), 'abc')?.failures.length, 1);
});

test('landing.junit-matches.a-case-main-does-not-fail: clause 3: a case main does not fail is not matched; with the setting off a JUnit-only run gives null [C7]', () => {
  const main = failureSignatures(run('breaks'), ROOT, { junitSignatures: true });
  const candidate = failureSignatures(run('breaks', 'new break'), ROOT, { junitSignatures: true });
  assert.equal(candidate.length, 2);
  assert.equal(matchingMainFailures(candidate, comparison(main), 'abc'), null);
  assert.equal(failureSignatures(run('breaks'), ROOT), null);
  assert.equal(failureSignatures(run('breaks'), ROOT, { junitSignatures: false }), null);
});
