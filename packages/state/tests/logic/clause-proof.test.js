/** The fail-before, pass-after judge proves a [test] clause only by an assertion failure at base and a pass at head [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
