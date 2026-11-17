/** @pullboard-test-input apps/cli/journeys/shout/journeys/fixture-presentation.test.js */
/** @pullboard-world-pin: clause 2 reads the journey source to count its cases. */
/**
 * The parity check for the shout fixture-presentation journey converted in #10152 (U149): one case runs twice, once with every journey CLI call a real
 * process and once in-process, and the exit codes, JSON results and board state must agree. One file per journey, so each has its own
 * budget and runs in its own shard [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/shout/journeys/fixture-presentation.test.js', cases: ["clause 1: borrowed board presentation keeps parity, shows staged rows, and leaves the caller connection open [N26,H16]"] }];

test('gate.parity-shout-fixture-presentation.sample-gives-same-results: clause 1: a sample of the shout fixture-presentation journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.parity-shout-fixture-presentation.journey-keeps-all-cases: clause 2: the shout fixture-presentation journey keeps all 3 of its cases, and the sampled case is one of them [C7]', () => {
  const source = readFileSync(new URL('../../../apps/cli/journeys/shout/journeys/fixture-presentation.test.js', import.meta.url), 'utf8');
  const cases = [...source.matchAll(/^test\((["'`])(.*?)\1/gmu)].map(match => match[2]);
  assert.equal(cases.length, 3, `the journey keeps its 3 cases, found ${cases.length}`);
  assert.ok(cases.includes(SAMPLES[0].cases[0]), 'the sampled case is still in the journey');
});
