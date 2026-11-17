/** @pullboard-test-input source-cell packages/landing */
/** @pullboard-world-pin: reads the one checked-in dart test report fixture, never a tool run. */
/** A Dart test JUnit report lands: the failing case is named and the passing one ticked, with no toolchain [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { junitCases } from '../../../../gate/light.js';
import { junitClauseTicks } from '../../../../gate/light.js';
import { junitFile } from '../../../src/logic/junit-files.js';
import { junitFailures } from '../../../src/logic/junit-failures.js';

const XML = readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'junit', 'dart.xml'), 'utf8');
const CLAUSES = [{ number: 1, kind: 'test' }, { number: 2, kind: 'test' }, { number: 3, kind: 'test' }];

test('landing.junit.dart-failing-case: clause 1: junitFailures names exactly the failing dart case with the file the dart row maps it to [C7]', () => {
  const { rows, code } = junitFailures(XML, '/work/repo');
  assert.equal(code, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'clause 2: halves a number');
  assert.match(rows[0].assertion, /^Expected: <2>/u);
  assert.equal(junitFile('dart', rows[0]), 'test/calc_test.dart');
});

test('landing.junit.dart-clause-ticks: clause 2: junitClauseTicks ticks the passing case clause and leaves the failing one unticked, naming it [C7]', () => {
  const result = junitClauseTicks(junitCases(XML).cases, CLAUSES);
  assert.deepEqual(result.ticked, [1]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].number, 2);
});

test('landing.junit.dart-no-toolchain: clause 3: the report is a checked-in fixture read as text, so no dart and no child process is needed [C7]', () => {
  assert.ok(XML.includes('junitreport:tojunit'));
  assert.equal(junitCases(XML).reason, null);
});
