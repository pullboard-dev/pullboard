/** @pullboard-test-input apps/cli/journeys/resume/flow.test.js */
/** @pullboard-world-pin: clause 2 reads the committed journey source to prove it still declares all of its cases. */
/**
 * The parity check for the resume/flow journey (U149): one representative case runs twice, once with every CLI call a real process
 * and once in-process, and the exit codes, JSON results and board state must agree. One file per journey, so each has its own budget
 * and runs in its own shard [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/resume/flow.test.js', cases: ["a worktree names its main checkout's uncommitted init files [I1,I2]"] }];

test('gate.journey-parity-resume-flow.a-sample-of-the-resume-flow-journey: clause 1: a sample of the resume/flow journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.journey-parity-resume-flow.the-resume-flow-journey-still-declares-all: clause 2: the resume/flow journey still declares all 16 of its test blocks, none dropped, skipped or merged [C7]', () => {
  const source = readFileSync(new URL('../../../apps/cli/journeys/resume/flow.test.js', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/^test\(/gmu)].length, 16, 'the journey keeps its 16 top-level test blocks');
  assert.doesNotMatch(source, /\b(?:test|it)\.(?:skip|todo|only)\b|\{\s*skip\s*:/u, 'no case is skipped');
});
