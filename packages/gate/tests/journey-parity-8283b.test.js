/** @pullboard-test-input apps/cli/journeys/verify/team/verdict.test.js */
/**
 * The parity check for the verify/team/verdict journey moved in-process (#8283, U149): the gate runs
 * one case of it twice, once with every CLI call a real process and once in-process, and fails on any difference in
 * exit code, JSON result or board state [C7]. The relay/team/coordinator sample is in journey-parity-8283.test.js; each sampled case runs twice, so the two journeys cannot share one file budget.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parityDifferences } from './fixtures/journey-parity.js';
import { runSample } from './fixtures/journey-parity.js';

/** Each converted journey, and the one case of it the sample runs both ways. */
const SAMPLES = [
  { journey: 'apps/cli/journeys/verify/team/verdict.test.js', cases: ['an accepted verdict reads stale through the CLI once main moves under its files'] },
];

test('gate.parity-8283b.sample-case-verdict-journey-gives: clause 1: a sample case of the verdict journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  // One after the other: the two modes side by side slow each other past the file budget.
  const real = await runSample('process', SAMPLES[0]);
  const inprocess = await runSample('inprocess', SAMPLES[0]);
  assert.ok(real.length >= 6, `the sample made its CLI calls (${real.length})`);
  assert.ok(real.some(row => row.board?.items.length), 'the records carry board state');
  const differences = parityDifferences(real, inprocess);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
