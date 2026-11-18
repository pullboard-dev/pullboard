/** @pullboard-world-pin: clause 3 counts the cases in the two journey files it names, whose source it reads. */
/** @pullboard-test-input apps/cli/journeys/verify/team/repair.test.js apps/cli/journeys/verify/team/repair-landing.test.js */
/**
 * The parity check for the verify/team repair journeys (#10062, U149 dep52 slice 1): the one case of each runs twice, once with every
 * CLI call a real process and once in-process, and the exit codes, JSON results and board state must agree. repair-landing was converted
 * by #10411, repair here [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [
  { journey: 'apps/cli/journeys/verify/team/repair.test.js', cases: ['clause 1: a checkout or trunk moving during verification cannot acquire proof [E8]'] },
  { journey: 'apps/cli/journeys/verify/team/repair-landing.test.js', cases: ['clause 2: landing retains the exact repair that passed stale re-review [E8,V8,R3]'] },
];

test('gate.journey-parity-u149-d52-1.a-sample-of-the-verify-team-repair: clause 1: a sample of the verify/team repair journey gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.journey-parity-u149-d52-1.both-converted-journeys-keep-their-one: clause 3: both converted journeys keep their one case each [C7]', () => {
  for (const { journey, cases } of SAMPLES) {
    const source = readFileSync(resolve(import.meta.dirname, '../../..', journey), 'utf8');
    assert.equal(source.match(/^test\(/gmu).length, 1, `${journey} keeps exactly one case`);
    assert.ok(source.includes(cases[0]), `${journey} keeps its case ${cases[0]}`);
  }
});
