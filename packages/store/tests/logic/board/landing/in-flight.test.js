/** @pullboard-test-input source-cell store */
/** inFlightBatches names the batches a landing lease record has in flight [C7,#8936,#9826]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inFlightBatches } from '../../../../src/logic/board/landing/in-flight.js';

test('store.logic-board-landing-in-flight.inflightbatches-lease-returns-the-batch-ids: clause 1: inFlightBatches(lease) returns the batch ids a lease record lists, in order [C7,#9826]', () => {
  assert.deepEqual(inFlightBatches({ generation: 4, holder: { token: 'b3' }, line: [], batches: ['b3', 'b1', 'b2'] }), ['b3', 'b1', 'b2']);
  assert.deepEqual(inFlightBatches({ generation: 4, holder: null, line: [], batches: [] }), []);
});

test('store.logic-board-landing-in-flight.a-lease-record-with-no-batch: clause 2: a lease record with no batch list reads as one batch in flight when it holds a running batch, none when idle [C7,#9826]', () => {
  assert.deepEqual(inFlightBatches({ generation: 2, holder: { token: 'tok-9', branch: 'landing/x' }, line: [] }), ['tok-9']);
  assert.deepEqual(inFlightBatches({ generation: 2, holder: null, line: [] }), []);
  assert.deepEqual(inFlightBatches({ generation: 0, holder: null, line: [{ token: 'queued' }] }), []);
  assert.deepEqual(inFlightBatches(null), []);
});
