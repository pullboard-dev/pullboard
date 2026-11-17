/** @pullboard-test-input apps/cli/journeys/engine/exchange.test.js */
/** @pullboard-world-pin: clause 2 counts the cases in the journey file it converts, so it reads that one declared input */
/**
 * The parity check for the engine/exchange journey (#9193, U149): the case that drives the export and import commands runs twice,
 * once with every CLI call a real process and once in-process, and the exit codes and printed results must agree [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/engine/exchange.test.js', cases: ['export and import CLI commands exchange a versioned document between real repos [A7]'] }];

test('gate.parity-engine-exchange.sample-engine-exchange-journey-gives: clause 1: a sample of the engine/exchange journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.parity-engine-exchange.engine-exchange-journey-keeps-all: clause 2: the engine/exchange journey keeps all 11 of its cases [C7]', () => {
  const source = readFileSync(resolve(import.meta.dirname, '../../../apps/cli/journeys/engine/exchange.test.js'), 'utf8');
  assert.equal((source.match(/^test\(/gmu) ?? []).length, 11, 'no case is dropped, skipped or merged');
  assert.doesNotMatch(source, /^test\.(?:skip|todo)\(/mu);
});
