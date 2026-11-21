/** @pullboard-test-input apps/cli/journeys/spec/main.test.js apps/cli/tests/io/resume/heartbeat.test.js */
/**
 * The parity check for the spec/main and resume/presence/heartbeat journeys (#8267, U149): one CLI-heavy case of each runs
 * twice, once with every CLI call a real process and once in-process, and any difference in exit code, JSON result, printed
 * text or board state fails [C7]. spec/changes stays out of the sample: its cost is git hooks, not CLI calls.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [
  { journey: 'apps/cli/journeys/spec/main.test.js', cases: ['spec check names both locations when ids repeat within or across configured files'] },
  { journey: 'apps/cli/tests/io/resume/heartbeat.test.js', cases: ['plain status counts large seat history and hides gone seats behind --all'] },
];

test('gate.journey-parity-spec-presence.the-spec-main-and-heartbeat-journeys-give: clause 1: the spec/main and heartbeat journeys give the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
