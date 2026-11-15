/** @pullboard-test-input apps/cli/journeys/decisions/row.test.js */
/**
 * The parity check for the row journey (#8276, U149 batch 4): one representative case runs twice, once with every CLI call a real
 * process and once in-process, and the exit codes, JSON results and board state must agree. One file per journey, so each has its
 * own budget and runs in its own shard [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parityDifferences } from './fixtures/journey-parity.js';
import { runSample } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/decisions/row.test.js', cases: ['[B26] agent markers and agent worktrees cannot decide rows; only the coordinator applies them'] }];

test('clause 1: a sample of the row journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', () => {
  const real = runSample(SAMPLES, 'process');
  const inprocess = runSample(SAMPLES, 'inprocess');
  assert.ok(real.length >= 3, `the sample made its CLI calls (${real.length})`);
  const differences = parityDifferences(real, inprocess);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
