/** The registry check reports an unregistered verify test by name and fails only in strict mode [C7,U148,#8374]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registryFindings } from '../../index.js';
import { registryOutcome } from '../../index.js';

const records = { 'verify.a.one': {} };
const files = [
  { file: 'a.test.js', source: "test('verify.a.one: clause 1: ok', () => {});\n" },
  { file: 'b.test.js', source: "test('verify.b.two: clause 2: ok', () => {});\ntest('no id here', () => {});\n" },
];

test('verify.registry.report-names-file: clause 1: with the strict setting off, an unregistered test is named in the report and the check passes [C7]', () => {
  const { findings } = registryFindings(files, records);
  const outcome = registryOutcome(findings, false);
  assert.equal(outcome.fails, false);
  assert.match(outcome.report, /b\.test\.js: test verify\.b\.two has no registry record/u);
  assert.match(outcome.report, /b\.test\.js: 1 test title\(s\) start without an ID/u);
});

test('verify.registry.strict-fails: clause 2: with the strict setting on, the same unregistered test fails the check naming the file [C7]', () => {
  const outcome = registryOutcome(registryFindings(files, records).findings, true);
  assert.equal(outcome.fails, true);
  assert.match(outcome.report, /b\.test\.js/u);
  assert.equal(registryOutcome(registryFindings(files.slice(0, 1), records).findings, true).fails, false, 'a fully registered cell passes in strict mode');
});
