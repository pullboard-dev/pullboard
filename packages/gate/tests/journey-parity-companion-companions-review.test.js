/** @pullboard-test-input apps/cli/journeys/companion/companions/review.test.js */
/**
 * The parity check for the companion/companions/review journey (#9192, U149): its one case runs twice, once with every CLI call a
 * real process and once in-process, and the exit codes, JSON results and board state must agree [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/companion/companions/review.test.js', cases: ['a reviewer gets the companion-composed tree and a bare tree cannot reject [V4,H16,G1]'] }];

test('clause 1: a sample of the companion/companions/review journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
