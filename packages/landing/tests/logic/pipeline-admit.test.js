/** admitBatch admits a new batch while fewer than two are in flight with the pipeline on, else only when none is [C7,#3155]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitBatch } from '../../src/logic/pipeline.js';
import { planQueue } from '../../src/logic/queue.js';

const batch = (id, items) => ({ id, parent: null, items, below: [] });

test('landing.pipeline-admit.with-the-pipeline-on-a-new: clause 1: with the pipeline on, a new batch is admitted with none or one in flight [C7]', () => {
  assert.equal(admitBatch({ inFlight: [], pipeline: true }), true);
  assert.equal(admitBatch({ inFlight: [batch('candidate-1', [1])], pipeline: true }), true);
  const { candidates } = planQueue({ arrivals: [2], inFlight: [batch('candidate-1', [1])] });
  assert.equal(admitBatch({ inFlight: candidates, pipeline: true }), true, 'a record planQueue made counts as one in flight');
});

test('landing.pipeline-admit.with-the-pipeline-on-a-third: clause 2: with the pipeline on, a third batch is refused while two are in flight [C7]', () => {
  const two = [batch('candidate-1', [1]), batch('candidate-2', [2])];
  assert.equal(admitBatch({ inFlight: two, pipeline: true }), false);
  assert.equal(admitBatch({ inFlight: [...two, batch('candidate-3', [3])], pipeline: true }), false);
});

test('landing.pipeline-admit.with-the-pipeline-off-a-new: clause 3: with the pipeline off, a new batch is admitted only when none is in flight [C7]', () => {
  assert.equal(admitBatch({ inFlight: [], pipeline: false }), true);
  assert.equal(admitBatch({ inFlight: [batch('candidate-1', [1])], pipeline: false }), false);
  assert.equal(admitBatch({ inFlight: [batch('candidate-1', [1]), batch('candidate-2', [2])], pipeline: false }), false);
});
