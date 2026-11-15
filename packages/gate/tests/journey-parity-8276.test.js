/** @pullboard-test-input apps/cli/journeys/resume/flow/setup.test.js apps/cli/journeys/merged/ratchet.test.js apps/cli/journeys/decisions/row.test.js */
/**
 * The parity check for the journeys of #8276 (U149 batch 4): one CLI-heavy case of each converted journey runs twice, once with every
 * CLI call a real process and once in-process, and the exit codes, JSON results and board state must agree. Its own file because
 * each sampled case runs twice, and the shared parity file's budget cannot hold them all [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parityDifferences } from './fixtures/journey-parity.js';
import { runSample } from './fixtures/journey-parity.js';

/** One representative case per journey. init/docs.test.js has no sampled case: its calls run a copied candidate's own scripts, so they stay real processes. */
const SAMPLES = [
  { journey: 'apps/cli/journeys/resume/flow/setup.test.js', cases: ['spec draft adds draft rows and resume names them [N32]'] },
  { journey: 'apps/cli/journeys/merged/ratchet.test.js', cases: ['manual merged records quarantine count without refusing historical publication [C7,T12]'] },
  { journey: 'apps/cli/journeys/decisions/row.test.js', cases: ['[B26] agent markers and agent worktrees cannot decide rows; only the coordinator applies them'] },
];

test('clause 1: a sample of the setup, ratchet and row journeys gives the same exit codes, JSON results and board state in a real process and in-process [C7]', () => {
  const real = runSample(SAMPLES, 'process');
  const inprocess = runSample(SAMPLES, 'inprocess');
  assert.ok(real.length >= 5, `the sample made its CLI calls (${real.length})`);
  const differences = parityDifferences(real, inprocess);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
