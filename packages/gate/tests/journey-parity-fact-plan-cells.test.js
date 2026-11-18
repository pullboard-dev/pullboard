/** @pullboard-test-input apps/cli/journeys/fact/plan/cells.test.js */
/** @pullboard-world-pin: clause 2 counts the cases in the journey file it converts, so it reads that one declared input */
/**
 * The parity check for the fact/plan/cells journey (#9202, U149): one representative case runs twice, once with every plan.js call a real
 * process and once in-process, and the exit codes and printed results must agree. The script keeps no board, so the sample is boardless [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/fact/plan/cells.test.js', boardless: true,
  cases: ['cut metadata refresh preserves frozen moves and records only current real source edges [D3,CD64]'] }];

test('gate.journey-parity-fact-plan-cells.a-sample-of-the-fact-plan-cells: clause 1: a sample of the fact/plan/cells journey gives the same exit codes and printed results in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.journey-parity-fact-plan-cells.the-fact-plan-cells-journey-keeps-all: clause 2: the fact/plan/cells journey keeps all 24 of its cases [C7]', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../../apps/cli/journeys/fact/plan/cells.test.js'), 'utf8');
  assert.equal((source.match(/^test\(/gmu) ?? []).length, 24, 'no case is dropped, skipped or merged');
  assert.doesNotMatch(source, /^test\.(?:skip|todo)\(/mu);
});
