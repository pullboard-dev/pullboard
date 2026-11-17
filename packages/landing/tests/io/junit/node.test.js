/** @pullboard-test-input source-cell packages/landing */
/** @pullboard-world-pin: reads the one checked-in Node native reporter report fixture, never a tool run. */
/** A Node native reporter JUnit report lands: the failing case is named with its file and the passing one ticked, with no toolchain [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { junitCases } from '../../../../gate/light.js';
import { junitClauseTicks } from '../../../../gate/light.js';
import { junitFile } from '../../../src/logic/junit-files.js';
import { junitFailures } from '../../../src/logic/junit-failures.js';

const XML = readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'junit', 'node.xml'), 'utf8');
const CLAUSES = [{ number: 1, kind: 'test' }, { number: 2, kind: 'test' }, { number: 3, kind: 'test' }];

test('landing.junit.node-failing-case: clause 1: junitFailures names exactly the failing Node native reporter case with the file the node row maps it to [C7]', () => {
  const { rows, code } = junitFailures(XML, '/work/repo');
  assert.equal(code, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'clause 2: halves a number');
  assert.match(rows[0].assertion, /strictly equal/u);
  assert.equal(rows[0].file, 'test/math.test.js');
  assert.equal(junitFile('node', rows[0]), 'test/math.test.js');
});

test('landing.junit.node-clause-ticks: clause 2: junitClauseTicks ticks the passing case clause and leaves the failing one unticked, naming it [C7]', () => {
  const result = junitClauseTicks(junitCases(XML).cases, CLAUSES);
  assert.deepEqual(result.ticked, [1]);
  assert.deepEqual(result.failed, [{ number: 2, name: 'clause 2: halves a number' }]);
});

test('landing.junit.node-no-toolchain: clause 3: the report is a checked-in fixture read as text, so no Node native reporter tool and no child process is needed [C7]', () => {
  assert.ok(XML.includes('node --test --test-reporter=junit'));
  assert.equal(junitCases(XML).reason, null);
});
