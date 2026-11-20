/** @pullboard-test-input apps/cli/tests/io/add/bar-lint.test.js */
/**
 * The parity check for the add bar-lint and publish agent journeys (#10067, U149 dep52 slice 6): one representative case from each
 * converted journey runs twice, once with every CLI call a real process and once in-process, and the exit codes, JSON results and
 * board state must agree. The other journeys of the slice keep only deliberate process-level calls (argv, start-up, a frozen clock,
 * node flags, a resident child) [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [
  { journey: 'apps/cli/tests/io/add/bar-lint.test.js', cases: ['clause 3: edit refuses the same faults through the real CLI and leaves the bar as it was [C7]'] },
  { journey: 'apps/cli/tests/io/commands/publish/agent.test.js', cases: ['pullboard publish from an agent shell pushes the green head [GH25]'] },
];

test('gate.journey-parity-u149-d52-6.sample-add-bar-lint-and-publish: clause 1: a sample of the add bar-lint and publish agent journeys gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
