/** @pullboard-test-input apps/cli/journeys/verify/team/repair.test.js apps/cli/journeys/verify/team/repair-landing.test.js */
/**
 * The parity check for the verify/team repair journeys (#10062, U149 dep52 slice 1): the one case of each runs twice, once with every
 * CLI call a real process and once in-process, and the exit codes, JSON results and board state must agree. repair-landing was converted
 * by #10411, repair here [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [
  { journey: 'apps/cli/journeys/verify/team/repair.test.js', cases: ['clause 1: a checkout or trunk moving during verification cannot acquire proof [E8]'] },
  { journey: 'apps/cli/journeys/verify/team/repair-landing.test.js', cases: ['clause 2: landing retains the exact repair that passed stale re-review [E8,V8,R3]'] },
];

test('clause 1: a sample of the verify/team repair journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
