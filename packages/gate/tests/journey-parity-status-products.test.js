/** @pullboard-test-input apps/cli/journeys/status/products.test.js */
/** @pullboard-world-pin: clause 2 counts the cases in the journey file it converts, so it reads that one declared input */
/**
 * The parity check for the status/products journey (#9203, U149): its real-repo case runs twice, once with every CLI call a real process
 * and once in-process, and the exit codes, printed results and board state must agree [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/status/products.test.js',
  cases: ['in a real repo, status prints each product, and spec check fails on an entry that names no row [S11, S12]'] }];

test('clause 1: a sample of the status/products journey gives the same exit codes, printed results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('clause 2: the status/products journey keeps all 5 of its cases [C7]', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../../apps/cli/journeys/status/products.test.js'), 'utf8');
  assert.equal((source.match(/^test\(/gmu) ?? []).length, 5, 'no case is dropped, skipped or merged');
  assert.doesNotMatch(source, /^test\.(?:skip|todo)\(/mu);
});
