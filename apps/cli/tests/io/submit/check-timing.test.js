/** The gate job request carries the bar's frozen check timing [C7,#8186]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gateJobRequest } from '../../../src/io/submit/pull.js';

const pinned = checkTiming => ({ main: 'a'.repeat(40), source: 'b'.repeat(40), trunk: 'a'.repeat(40), base: null, check: 'node x.js', criterion: '', title: 't',
  composition: null, config: {}, crossRunTests: [], cutRows: [], produceInventory: [], doctrine: null, authorization: null, browserFreeChecks: false, checkTiming });

test('cli.io-submit-check-timing.a-bar-frozen-with-check-timing-puts: clause 1: a bar frozen with check timing puts it on the gate job request data [C7]', () => {
  const { input } = gateJobRequest(pinned(true));
  assert.equal(input.data.checkTiming, true);
  assert.equal('checkTiming' in input.data.analysis, false, 'timing rides the job data, not the analysis');
});

test('cli.io-submit-check-timing.a-bar-frozen-without-check-timing-leaves: clause 1: a bar frozen without check timing leaves the request as it was [C7]', () => {
  assert.equal('checkTiming' in gateJobRequest(pinned(false)).input.data, false);
  assert.equal('checkTiming' in gateJobRequest(pinned(undefined)).input.data, false);
});
