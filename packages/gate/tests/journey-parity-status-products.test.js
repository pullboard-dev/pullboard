/** @pullboard-test-input apps/cli/journeys/status/products.test.js */
/**
 * The parity check for the status/products journey (#9203, U149): its real-repo case runs twice, once with every CLI call a real process
 * and once in-process, and the exit codes, printed results and board state must agree [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/status/products.test.js',
  cases: ['in a real repo, status prints each product, and spec check fails on an entry that names no row [S11, S12]'] }];

test('clause 1: a sample of the status/products journey gives the same exit codes, printed results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
