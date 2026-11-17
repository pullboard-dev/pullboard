/** @pullboard-test-input apps/cli/journeys/doctrine/readme.test.js */
/** @pullboard-world-pin: clause 2 reads the committed doctrine/readme journey source to count that it still has all 19 cases. */
/**
 * The parity check for the doctrine/readme journey (U149): one representative case runs twice, once with every CLI call a real
 * process and once in-process, and the exit codes, JSON results and board state must agree. One file per journey, so each has its
 * own budget and runs in its own shard [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

// boardless: the sampled case runs spec and doctrine checks in a clone of the repo, which keeps no board to compare.
const SAMPLES = [{ journey: 'apps/cli/journeys/doctrine/readme.test.js', cases: ["Pullboard's doctrine carries its four checks [D1,D3]"], boardless: true }];

test('clause 1: a sample of the doctrine/readme journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('clause 2: the doctrine/readme journey keeps all 19 of its cases, each green in this run [C7]', () => {
  const source = readFileSync(new URL('../../../apps/cli/journeys/doctrine/readme.test.js', import.meta.url), 'utf8');
  assert.equal(source.match(/^test\(/gmu).length, 19, 'no case was dropped');
  assert.doesNotMatch(source, /\btest\.(?:skip|todo)\(|\bskip: true/u, 'no case is skipped');
});
