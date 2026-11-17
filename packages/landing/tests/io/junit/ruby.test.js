/** @pullboard-test-input source-cell packages/landing */
/** @pullboard-world-pin: reads the one checked-in RSpec report fixture, never a tool run. */
/** An RSpec JUnit report lands: the failing case is named with its file and the passing one ticked, with no toolchain [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { junitCases } from '../../../../gate/light.js';
import { junitClauseTicks } from '../../../../gate/light.js';
import { junitFile } from '../../../src/logic/junit-files.js';
import { junitFailures } from '../../../src/logic/junit-failures.js';

const XML = readFileSync(join(import.meta.dirname, '..', '..', 'fixtures', 'junit', 'ruby.xml'), 'utf8');
const CLAUSES = [{ number: 1, kind: 'test' }, { number: 2, kind: 'test' }, { number: 3, kind: 'test' }];

test('landing.junit.ruby-failing-case: clause 1: junitFailures names exactly the failing RSpec case with the file the ruby row maps it to [C7]', () => {
  const { rows, code } = junitFailures(XML, '/work/repo');
  assert.equal(code, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'clause 2: halves a number');
  assert.match(rows[0].assertion, /expected: 2/u);
  assert.equal(junitFile('ruby', rows[0]), 'spec/calc_spec.rb');
  assert.equal(junitFile('ruby', { classname: 'spec.calc_spec', file: null }), 'spec/calc_spec.rb');
});

test('landing.junit.ruby-clause-ticks: clause 2: junitClauseTicks ticks the passing case clause and leaves the failing one unticked, naming it [C7]', () => {
  const result = junitClauseTicks(junitCases(XML).cases, CLAUSES);
  assert.deepEqual(result.ticked, [1]);
  assert.deepEqual(result.failed, [{ number: 2, name: 'clause 2: halves a number' }]);
});

test('landing.junit.ruby-no-toolchain: clause 3: the report is a checked-in fixture read as text, so no rspec and no child process is needed [C7]', () => {
  assert.ok(XML.includes('rspec --format RspecJunitFormatter --out rspec.xml'));
  assert.equal(junitCases(XML).reason, null);
});
