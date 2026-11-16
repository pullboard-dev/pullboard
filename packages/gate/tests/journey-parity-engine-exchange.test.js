/** @pullboard-test-input apps/cli/journeys/engine/exchange.test.js */
/**
 * The parity check for the engine/exchange journey (#9193, U149): the case that drives the export and import commands runs twice,
 * once with every CLI call a real process and once in-process, and the exit codes and printed results must agree [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/engine/exchange.test.js', cases: ['export and import CLI commands exchange a versioned document between real repos [A7]'] }];

test('clause 1: a sample of the engine/exchange journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
