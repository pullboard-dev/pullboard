/** A pulled gate whose pinned analysis tooling throws names RUNNER_TOOLING_CRASH with the thrown message [C7,P7]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analysisCrash } from '../../../src/io/submit/pull.js';
import { gateJobRequest } from '../../../src/io/submit/pull.js';

const stack = ['file:///tmp/pullboard-trusted-main-x/packages/gate/index.js:9', 'TypeError: cannot read properties of undefined (reading \'files\')',
  '    at plan (file:///tmp/pullboard-trusted-main-x/packages/gate/index.js:9:3)', '    at async main (file:///tmp/t/pullboard-trusted-analysis.mjs:4:1)'].join('\n');

test('clause 1: a thrown analysis names RUNNER_TOOLING_CRASH with the thrown message and frame [C7,P7]', () => {
  const line = analysisCrash(stack);
  assert.match(line, /^RUNNER_TOOLING_CRASH: /u);
  assert.match(line, /TypeError: cannot read properties of undefined/u);
  assert.match(line, /packages\/gate\/index\.js:9:3/u);
});

test('clause 1: output with no thrown error stays the plain no-result report [C7,P7]', () => {
  assert.equal(analysisCrash('killed by the runner'), null);
  assert.equal(analysisCrash('    at stray (x.js:1:1)'), null);
});

test('clause 1: the gate job entry carries the crash naming into the pulled receipt error [C7,P7]', () => {
  const { input } = gateJobRequest({ main: 'a'.repeat(40), source: 'b'.repeat(40), trunk: 'a'.repeat(40), base: null, check: 'true', criterion: '', title: 't',
    composition: null, config: {}, crossRunTests: [], cutRows: [], produceInventory: [], doctrine: null, authorization: null, browserFreeChecks: false });
  assert.ok(input.entry.includes('function analysisCrash('));
  assert.ok(input.entry.includes('receipt.error = analysisCrash(said)'));
});
