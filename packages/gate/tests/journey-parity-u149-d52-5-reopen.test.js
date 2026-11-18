/** @pullboard-test-input apps/cli/journeys/reopen/evidence.test.js */
/**
 * The parity check for the reopen journey (#10066, U149 dep52 slice 5): one representative case runs twice, once with every CLI call a
 * real process and once in-process, and the exit codes, JSON results and board state must agree. The show journey of the slice has its
 * own file, journey-parity-u149-d52-5.test.js, so each stays inside its file budget and runs in its own shard [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [
  { journey: 'apps/cli/journeys/reopen/evidence.test.js', cases: ['a landing reopen carries the exact failing assertion [C7,B22]'] },
];

test('gate.parity-u149-d52-5-reopen.sample-gives-same-results: clause 1: a sample of the reopen journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
