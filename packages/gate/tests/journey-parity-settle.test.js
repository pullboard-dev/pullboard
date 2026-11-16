/** @pullboard-test-input apps/cli/journeys/spec/e2e/next.test.js apps/cli/tests/fixtures/submit/settle.js apps/cli/tests/fixtures/e2e.js */
/** @pullboard-world-pin: clause 2 reads the committed settle fixture source to prove its gate wait reads show in this process. */
/**
 * The parity check for the settle fixture (U149): its gate wait now reads `show` in this process, so a journey that settles a pulled
 * submit runs one sampled case twice, once with every journey CLI call a real process and once in-process, and the exit codes, JSON
 * results and board state must agree. The wait's own reads are no longer journey calls, so the call count no longer follows timing [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/spec/e2e/next.test.js', cases: ['verify runs at the submitted commit, against the criterion frozen at claim [V3, V7, V9, V19]'] }];

test('clause 1: a settled-submit sample gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('clause 2: the settle fixture reads show for its gate wait through the box in-process call, whatever run its caller passes [C7]', () => {
  const source = readFileSync(new URL('../../../apps/cli/tests/fixtures/submit/settle.js', import.meta.url), 'utf8');
  const wait = source.slice(source.indexOf('export function settledGateJob'), source.indexOf('export async function settleSubmit'));
  assert.match(wait, /readShown\(box, item\)/u, 'the wait reads show through readShown');
  assert.doesNotMatch(wait, /box\.run\(/u, 'the wait starts no CLI call through the caller run');
  assert.match(source, /box\.inProcess \?\? box\.run/u, 'readShown answers show with the box in-process call, falling back to the box run');
});
