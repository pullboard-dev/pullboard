/** @pullboard-test-input apps/cli/journeys/cells/against.test.js */
/**
 * The parity check for the cells/against journey (#9201, U149): one representative case runs twice, once with the cell-lints call a real
 * process and once in-process, and the exit code and printed debt must agree. The script keeps no board, so the sample is boardless [C7].
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/cells/against.test.js', boardless: true,
  cases: ["cell-lints --check names the debt the item adds over main's committed baseline, naming its file [C7]"] }];

test('clause 1: a sample of the cells/against journey gives the same exit codes and printed results in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});
