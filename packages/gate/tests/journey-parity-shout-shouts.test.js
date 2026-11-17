/** @pullboard-test-input apps/cli/journeys/shout/shouts.test.js */
/**
 * The parity check for the shout/shouts journey (U149): one representative case runs twice, once with every CLI call a real
 * process and once in-process, and the exit codes, JSON results and board state must agree. One file per journey, so each has its
 * own budget and runs in its own shard [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/shout/shouts.test.js', cases: ['clause 2: a shout shows the evidence it carries [B22]'] }];

test('clause 1: a sample of the shout/shouts journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
