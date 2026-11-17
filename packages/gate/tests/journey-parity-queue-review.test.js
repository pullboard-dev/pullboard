/** @pullboard-test-input apps/cli/journeys/queue/review.test.js */
/**
 * The parity check for the queue/review journey (U149): its CLI calls already ran in this process on a fixed board clock, so the call
 * helper now also answers as a real process under PULLBOARD_JOURNEY_MODE=process. One representative case runs twice, once each way,
 * and the exit codes, JSON results and board state must agree. One file per journey, so each has its own budget and shard [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/queue/review.test.js', cases: ['clause 2: [Q1,V15] next hands out the mandatory review before a new claim'] }];

test('gate.journey-parity-queue-review.a-sample-of-the-queue-review-journey: clause 1: a sample of the queue/review journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
