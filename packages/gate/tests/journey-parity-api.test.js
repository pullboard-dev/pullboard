/** @pullboard-test-input apps/cli/journeys/shout/http.test.js apps/cli/tests/fixtures/api.js */
/** @pullboard-world-pin: clause 2 reads the committed api fixture source to prove its in-process calls start no CLI process. */
/**
 * The parity check for the api.js fixture (U149): its CLI calls (init, add, fact, settings, shout) are now answered in-process, so a
 * journey that uses it runs one sampled case twice, once with every CLI call a real process and once in-process, and the exit codes,
 * JSON results and board state must agree. A real process is left only under PULLBOARD_JOURNEY_MODE=process [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/shout/http.test.js', cases: ['[A2] local HTTP state accepts a safe seen cursor and committed code previews'] }];

test('clause 1: an api.js fixture sample gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('clause 2: the api.js fixture starts no CLI process for its calls when the journey runs in-process [C7]', () => {
  const source = readFileSync(new URL('../../../apps/cli/tests/fixtures/api.js', import.meta.url), 'utf8');
  assert.equal(source.match(/runFixtureChild\(process\.execPath/gu)?.length, 1, 'the fixture has one real launch, the process-mode path');
  assert.match(source, /JOURNEY_MODE === 'process' \? realRun\(cwd, \.\.\.args\) : runCliSync\(args/u, 'the sync calls reach the CLI in a warm worker unless the journey runs as processes');
  assert.match(source, /journeyCall\(\{ dir, env, cwd, args: called, inProcess: \(\) => runCliInProcess\(called/u, 'cliLocal answers in this process through the journey kit');
});
