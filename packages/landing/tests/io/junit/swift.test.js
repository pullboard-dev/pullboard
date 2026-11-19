/** @pullboard-test-input source-cell packages/landing */
/** @pullboard-world-pin: reads the one checked-in SwiftPM report fixture, never a tool run. */
/** A SwiftPM JUnit report lands: the failing case is named with its file and the passing one ticked, with no toolchain [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { junitCases } from '../../../../gate/light.js';
import { junitClauseTicks } from '../../../../gate/light.js';
import { junitFile } from '../../../src/logic/junit-files.js';
import { junitFailures } from '../../../src/logic/junit-failures.js';

const XML = readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'junit', 'swift.xml'), 'utf8');
const CLAUSES = [{ number: 1, kind: 'test' }, { number: 2, kind: 'test' }, { number: 3, kind: 'test' }];

test('landing.junit.swift-failing-case: clause 1: junitFailures names exactly the failing SwiftPM case with the file the swift row maps it to [C7]', () => {
  const { rows, code } = junitFailures(XML, '/work/repo');
  assert.equal(code, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'clause 2: halves a number');
  assert.match(rows[0].assertion, /^XCTAssertEqual failed/u);
  assert.equal(junitFile('swift', rows[0]), 'Tests/CalcTests/CalcTests.swift');
});

test('landing.junit.swift-clause-ticks: clause 2: junitClauseTicks ticks the passing case clause and leaves the failing one unticked, naming it [C7]', () => {
  const result = junitClauseTicks(junitCases(XML).cases, CLAUSES);
  assert.deepEqual(result.ticked, [1]);
  assert.deepEqual(result.failed, [{ number: 2, name: 'clause 2: halves a number' }]);
});

test('landing.junit.swift-no-toolchain: clause 3: the report is a checked-in fixture read as text, so no swift and no child process is needed [C7]', () => {
  assert.ok(XML.includes('swift test --xunit-output report.xml'));
  assert.equal(junitCases(XML).reason, null);
});
