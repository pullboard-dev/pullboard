/** @pullboard-test-input apps/cli/journeys/fact/board/schema-carry.test.js */
/**
 * The parity check for the fact/board/schema-carry journey (#9194, U149): its one case runs twice, once with every CLI call a real
 * process and once in-process, and the exit codes, JSON results and board state must agree. The one call that stays a real process
 * runs a copied main checkout's own entry and is not recorded [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/fact/board/schema-carry.test.js', cases: ['a stamped pre-carry board upgrades on main open and completes a native merge-only submission [M3,V1,V4,H16]'] }];

test('gate.journey-parity-fact-board-schema-carry.a-sample-of-the-fact-board-schema: clause 1: a sample of the fact/board/schema-carry journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
