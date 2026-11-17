/** @pullboard-test-input apps/cli/journeys/show/main.test.js */
/**
 * The parity check for the show and reopen journeys (#10066, U149 dep52 slice 5): one representative case from each converted journey
 * runs twice, once with every CLI call a real process and once in-process, and the exit codes, JSON results and board state must
 * agree. The other journeys of the slice keep only deliberate process-level calls (argv, start-up, a frozen clock, a resident child) [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [
  { journey: 'apps/cli/journeys/show/main.test.js', cases: ['show prints the latest verdict in full and earlier ones as one line; --history and --json print every note [N30]'] },
  { journey: 'apps/cli/journeys/reopen/evidence.test.js', cases: ['a landing reopen carries the exact failing assertion [C7,B22]'] },
];

test('clause 1: a sample of the show and reopen journeys gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
