/** @pullboard-test-input apps/cli/journeys/show/main.test.js */
/**
 * The parity check for the show journey (#10066, U149 dep52 slice 5): one representative case runs twice, once with every CLI call a
 * real process and once in-process, and the exit codes, JSON results and board state must agree. The reopen journey of the slice has its
 * own file, journey-parity-u149-d52-5-reopen.test.js, so each stays inside its file budget and runs in its own shard [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [
  { journey: 'apps/cli/journeys/show/main.test.js', cases: ['show prints the latest verdict in full and earlier ones as one line; --history and --json print every note [N30]'] },
];

test('gate.parity-u149-d52-5-show.sample-gives-same-results: clause 1: a sample of the show journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
