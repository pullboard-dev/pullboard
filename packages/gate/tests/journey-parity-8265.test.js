/** @pullboard-test-input apps/cli/journeys/fact/msg.test.js apps/cli/journeys/fact/board/busy.test.js */
/**
 * The parity sample for the #8265 batch (U149): one representative CLI-heavy case per converted journey runs as a real process and
 * in-process, and any difference in exit code, JSON result, printed text or board state fails [C7]. It has its own file because each
 * case runs twice and one shared file would pass the gate's 180 s budget.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

/** fact/board/schema is not sampled: its one CLI case submits through a pulled gate job, whose activity counts race the settle, so the runs differ by timing, not product. */
const SAMPLES = [
  { journey: 'apps/cli/journeys/fact/msg.test.js', cases: ['a fresh board accepts a first commit that cites its item'] },
  { journey: 'apps/cli/journeys/fact/board/busy.test.js', cases: ['a standalone native attempt and nested rollback each observe only their actual outer write'] },
];

test('clause 1: the msg and busy journey samples give the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
