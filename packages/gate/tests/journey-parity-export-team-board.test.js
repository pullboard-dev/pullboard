/** @pullboard-test-input apps/cli/journeys/export/team/board.test.js */
/**
 * The parity check for the export/team/board journey moved in-process (U149): its box.cli calls are now journey calls, answered in this
 * process by default, so the one case runs twice, once with every CLI call a real process and once in-process, and the exit codes,
 * JSON results and board state must agree [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/export/team/board.test.js', cases: ['clause 2: a private board sits beside the repo board [E11,E13,E14,E15]'] }];

test('clause 1: the export/team/board journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
