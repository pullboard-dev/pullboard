/** @pullboard-test-input apps/cli/journeys/doctrine/readme.test.js */
/**
 * The parity check for the doctrine/readme journey (U149): one representative case runs twice, once with every CLI call a real
 * process and once in-process, and the exit codes, JSON results and board state must agree. One file per journey, so each has its
 * own budget and runs in its own shard [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

// boardless: the sampled case runs spec and doctrine checks in a clone of the repo, which keeps no board to compare.
const SAMPLES = [{ journey: 'apps/cli/journeys/doctrine/readme.test.js', cases: ["Pullboard's doctrine carries its four checks [D1,D3]"], boardless: true }];

test('clause 1: a sample of the doctrine/readme journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
