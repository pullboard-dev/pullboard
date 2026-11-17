/** @pullboard-test-input apps/cli/journeys/verify/team/repair.test.js */
/**
 * The parity check for the verify/team repair journey moved (repair-landing keeps real submit, verify and land: in-process they stalled past the file budget on the runner, run 16a6bbf5) in-process (#10062, U149 dep52 slice 1): its case runs twice,
 * once with every CLI call a real process and once in-process, and the exit codes, JSON results and board state must agree [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [
  { journey: 'apps/cli/journeys/verify/team/repair.test.js', cases: ['clause 1: a checkout or trunk moving during verification cannot acquire proof [E8]'] },
];

test('clause 1: a sample of the verify/team repair journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
