/** @pullboard-test-input apps/cli/journeys/show/policy/dependency.test.js */
/**
 * The parity check for the show/policy/dependency journey (U149): its one case runs twice, once with every journey CLI call a real
 * process and once in-process, and the exit codes, JSON results and board state must agree. One file per journey, so each has its own
 * budget and runs in its own shard [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/show/policy/dependency.test.js', cases: ["a dependency's own verified dependency admits its files [N16,V4]"] }];

test('clause 1: a sample of the show/policy/dependency journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
