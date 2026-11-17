import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junitClauseTicks } from '../../src/logic/junit-ticks.js';

const CLAUSES = [{ number: 1, kind: 'test' }, { number: 2, kind: 'test' }, { number: 3, kind: 'test' }, { number: 4, kind: 'measurement' }];

test('clause 1: junitClauseTicks ticks each [test] clause whose case the report lists as passed [C7]', () => {
  const cases = [{ name: 'clause 1: adds', outcome: 'pass' }, { name: 'clause 2: sums', outcome: 'pass' }];
  const result = junitClauseTicks(cases, CLAUSES);
  assert.deepEqual(result.ticked, [1, 2]);
  assert.deepEqual(result.failed, []);
});

test('clause 2: a failing case leaves its clause unticked and the result names the case [C7]', () => {
  const cases = [{ name: 'clause 1: adds', outcome: 'pass' }, { name: 'clause 2: sums', outcome: 'fail' }, { name: 'clause 2: more', outcome: 'pass' }];
  const result = junitClauseTicks(cases, CLAUSES);
  assert.deepEqual(result.ticked, [1]);
  assert.deepEqual(result.failed, [{ number: 2, name: 'clause 2: sums' }]);
});

test('clause 3: a clause with no case in the report is neither ticked nor failed [C7]', () => {
  const cases = [{ name: 'clause 1: adds', outcome: 'pass' }, { name: 'unrelated case', outcome: 'fail' }, { name: 'clause 3: later', outcome: 'skip' }];
  const result = junitClauseTicks(cases, CLAUSES);
  assert.deepEqual(result.ticked, [1]);
  assert.deepEqual(result.failed, []);
});
