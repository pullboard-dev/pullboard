/** @pullboard-test-input apps/cli/journeys/worktree/start.test.js */
/**
 * The parity check for the worktree/start journey (#10063, U149 dep52 slice 2): one timing-independent case runs twice, once with every
 * CLI call a real process and once in-process, and the exit codes, JSON results and board state must agree. The view/e2e journey starts
 * and stops its own view listener and the test/cells journey runs no CLI call, so both stay as they are [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/worktree/start.test.js', cases: ["the README's worktree command works in a fresh repo [I1,I2]"] }];

test('clause 1: a sample of the worktree/start journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
