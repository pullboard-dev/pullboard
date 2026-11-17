/** @pullboard-test-input apps/cli/journeys/relay/team/coordinator.test.js */
/**
 * The parity check for the relay/team/coordinator journey moved in-process (#8283, U149): the gate runs
 * one case of it twice, once with every CLI call a real process and once in-process, and fails on any difference in
 * exit code, JSON result or board state [C7]. The verify/team/verdict sample is in journey-parity-8283b.test.js; each sampled case runs twice, so the two journeys cannot share one file budget.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parityDifferences } from './fixtures/journey-parity.js';
import { runSample } from './fixtures/journey-parity.js';

/** Each converted journey, and the one case of it the sample runs both ways. */
const SAMPLES = [
  { journey: 'apps/cli/journeys/relay/team/coordinator.test.js', cases: ['an agent session on a computer that does not hold the coordinator takes it over'] },
];

test('gate.parity-8283.sample-case-coordinator-journey-gives: clause 1: a sample case of the coordinator journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  // One after the other: the two modes side by side slow each other past the file budget.
  const real = await runSample('process', SAMPLES[0]);
  const inprocess = await runSample('inprocess', SAMPLES[0]);
  assert.ok(real.length >= 5, `the sample made its CLI calls (${real.length})`);
  assert.ok(real.some(row => row.board?.items.length), 'the records carry board state');
  const differences = parityDifferences(real, inprocess);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
