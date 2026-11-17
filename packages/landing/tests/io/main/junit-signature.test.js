/** A failing JUnit case gets a signature that survives a rerun on another runner [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { junitFailureSignature } from '../../../src/logic/junit-signature.js';

const ROW = { name: 'breaks', classname: 'a.B', file: 'tests/a.py', assertion: 'assert 1 == 2' };

test('clause 1: junitFailureSignature returns a 64-hex sha256 of name, file and message [C7]', () => {
  assert.match(junitFailureSignature(ROW, '/work/repo'), /^[0-9a-f]{64}$/u);
});

test('clause 2: the same case under two checkout paths gives one signature [C7]', () => {
  const a = { ...ROW, assertion: 'failed at /Users/x/.pullboard-runner/jobs/aaaa-1/tmp/pullboard-AbC123/out.txt' };
  const b = { ...ROW, assertion: 'failed at /Users/y/.pullboard-runner/jobs/bbbb-2/tmp/pullboard-XyZ987/out.txt' };
  assert.equal(junitFailureSignature(a, '/one/checkout'), junitFailureSignature(b, '/two/checkout'));
});

test('clause 2: a different case, file or message gives another signature [C7]', () => {
  const base = junitFailureSignature(ROW, '/r');
  assert.notEqual(base, junitFailureSignature({ ...ROW, name: 'other' }, '/r'));
  assert.notEqual(base, junitFailureSignature({ ...ROW, file: 'tests/b.py' }, '/r'));
  assert.notEqual(base, junitFailureSignature({ ...ROW, assertion: 'assert 1 == 3' }, '/r'));
});

test('clause 3: a row without a file gives null, never a signature [C7]', () => {
  assert.equal(junitFailureSignature({ ...ROW, file: null }, '/r'), null);
  assert.equal(junitFailureSignature({ name: 'x' }, '/r'), null);
});
