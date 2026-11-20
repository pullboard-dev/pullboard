/** @pullboard-test-input apps/cli/journeys/merged/ratchet-landing-part2.test.js */
/**
 * The parity check for the ratchet journey (#8276, U149 batch 4): one representative case runs twice, once with every CLI call a real
 * process and once in-process, and the exit codes, JSON results and board state must agree. One file per journey, so each has its
 * own budget and runs in its own shard [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/merged/ratchet-landing-part2.test.js', cases: ['manual merged records quarantine count without refusing historical publication [C7,T12]'] }];

test('gate.journey-parity-ratchet.a-sample-of-the-ratchet-journey-gives: clause 1: a sample of the ratchet journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
