/** @pullboard-test-input apps/cli/tests/io/commands/companion/review.test.js */
/** @pullboard-world-pin: clause 2 counts the cases in the journey file it converts, so it reads that one declared input */
/**
 * The parity check for the companion/companions/review journey (#9192, U149): its one case runs twice, once with every CLI call a
 * real process and once in-process, and the exit codes, JSON results and board state must agree [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/tests/io/commands/companion/review.test.js', cases: ['a reviewer gets the companion-composed tree and a bare tree cannot reject [V4,H16,G1]'] }];

test('gate.parity-companion-companions-review.sample-companion-companions-review-journey: clause 1: a sample of the companion/companions/review journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.parity-companion-companions-review.companion-companions-review-journey-keeps: clause 2: the companion/companions/review journey keeps all 1 of its cases [C7]', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../../apps/cli/tests/io/commands/companion/review.test.js'), 'utf8');
  assert.equal((source.match(/^test\(/gmu) ?? []).length, 1, 'no case is dropped, skipped or merged');
  assert.doesNotMatch(source, /^test\.(?:skip|todo)\(/mu);
});
