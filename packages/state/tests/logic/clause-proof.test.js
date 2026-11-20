/** The fail-before, pass-after judge proves a [test] clause only by an assertion failure at base and a pass at head [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clauseInspectionProblem } from '../../index.js';
import { failBeforePassAfter } from '../../index.js';

const FILE = 'test/a.test.js';
const row = (name, passed, extra = {}) => ({ file: FILE, name, passed, skipped: false, ...extra });
const fail = name => row(name, false, { failure: 'assertion' });

test('state.logic-clause-proof.clause-1-an-assertion-failure-at-base: clause 1: an assertion failure at base and all passing at head is proven [C7]', () => {
  const verdict = failBeforePassAfter([fail('x'), row('y', true)], [row('x', true), row('y', true)], FILE);
  assert.equal(verdict.proven, true);
  assert.deepEqual(verdict.cases, ['x']);
});

test('state.logic-clause-proof.clause-1-a-case-still-failing-at-head-is: clause 1: a case still failing at head is not proven [C7]', () => {
  assert.equal(failBeforePassAfter([fail('x')], [fail('x')], FILE).proven, false);
});

test('state.logic-clause-proof.clause-2-a-load-error-zero-tests-or-only: clause 2: a load error, zero tests or only skips at base are each refused with their own reason [C7]', () => {
  const head = [row('x', true)];
  const load = failBeforePassAfter([row('file', false, { failure: 'error' })], head, FILE);
  const none = failBeforePassAfter([], head, FILE);
  const skipped = failBeforePassAfter([{ file: FILE, name: 'x', passed: false, skipped: true }], head, FILE);
  const unrecorded = failBeforePassAfter([row('x', false)], head, FILE);
  for (const verdict of [load, none, skipped, unrecorded]) assert.equal(verdict.proven, false);
  assert.match(load.reason, /load error/u);
  assert.match(none.reason, /zero tests/u);
  assert.match(skipped.reason, /skipped/u);
  assert.equal(new Set([load.reason, none.reason, skipped.reason]).size, 3);
});

test('state.logic-clause-proof.clause-3-only-the-named-file-s-rows: clause 3: only the named file\'s rows count and the inputs are not changed [C7]', () => {
  const base = [{ ...fail('x'), file: 'other.test.js' }];
  const copy = structuredClone(base);
  assert.equal(failBeforePassAfter(base, [row('x', true)], FILE).proven, false);
  assert.deepEqual(base, copy);
  assert.equal(failBeforePassAfter(null, undefined, FILE).proven, false);
});

const ITEM = { item_id: 1, item_owner: 'a', item_criterion: '1. test/a.test.js passes on a runner [test]' };
const inspect = outcomes => clauseInspectionProblem(ITEM, [], { greenFiles: new Set([FILE]), gateFiles: new Set([FILE]), outcomes });

test('state.logic-clause-proof.clause-1-a-file-whose-cases-were-all-skipped: clause 1: a green run whose cases in the file were all skipped leaves the clause unproven even with the file in greenFiles [C7]', () => {
  const problem = inspect([{ file: FILE, name: 'x', passed: false, skipped: true, runner: 'pooled-runner-1' }]);
  assert.ok(problem);
  assert.equal(problem.code, 'CLAUSE_UNTICKED');
});

test('state.logic-clause-proof.clause-2-the-refusal-names-the-runner: clause 2: the refusal names the runner and the skipped case titles [C7]', () => {
  const problem = inspect([{ file: FILE, name: 'pytest case one', skipped: true, runner: 'pooled-runner-1' }, { file: FILE, name: 'php case two', skipped: true, runner: 'pooled-runner-1' }]);
  assert.match(problem.message, /pooled-runner-1/u);
  assert.match(problem.message, /pytest case one; php case two/u);
});

test('state.logic-clause-proof.clause-3-a-run-with-a-passed-case-still-ticks: clause 3: a run with at least one passed case still ticks the clause, and no outcomes change nothing [C7]', () => {
  assert.equal(inspect([{ file: FILE, name: 'x', skipped: true }, row('y', true)]), null);
  assert.equal(inspect([]), null);
});
