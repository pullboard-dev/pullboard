/** @pullboard-test-input source-cell packages/landing packages/gate */
/** @pullboard-world-pin: reads the one checked-in Deno report fixture, never a tool run. */
/** A Deno JUnit report lands: the failing case is named with its file and the passing one ticked, with no toolchain [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { junitCases } from '../../../../gate/light.js';
import { junitClauseTicks } from '../../../../gate/light.js';
import { junitFile } from '../../../src/logic/junit-files.js';
import { junitFailures } from '../../../src/logic/junit-failures.js';

const XML = readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'junit', 'deno.xml'), 'utf8');
const CLAUSES = [{ number: 1, kind: 'test' }, { number: 2, kind: 'test' }, { number: 3, kind: 'test' }];

test('landing.junit.deno-failing-case: clause 1: junitFailures names exactly the failing case with the file the deno row maps it to [C7]', () => {
  const { rows, code } = junitFailures(XML, '/work/repo');
  assert.equal(code, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'halves a number');
  assert.match(rows[0].assertion, /expected/u);
  assert.equal(junitFile('deno', rows[0]), 'calc_test.ts');
});

test('landing.junit.deno-clause-ticks: clause 2: junitClauseTicks ticks the passing case clause and leaves the failing one unticked, naming it [C7]', () => {
  const result = junitClauseTicks(junitCases(XML).cases, CLAUSES);
  assert.deepEqual(result.ticked, [1]);
  assert.deepEqual(result.failed, [{ number: 2, name: 'halves a number' }]);
});

test('landing.junit.deno-no-toolchain: clause 3: the report is a checked-in fixture read as text, so no Deno and no child process is needed [C7]', () => {
  assert.ok(XML.includes('deno test --junit-path=report.xml'));
  assert.equal(junitCases(XML).reason, null);
});
