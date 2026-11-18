/** @pullboard-test-input apps/cli/journeys/add/split.test.js apps/cli/tests/fixtures/land/board.js */
/** @pullboard-world-pin: clause 2 reads the committed land board fixture source to prove its quick calls start no CLI process in-process. */
/**
 * The parity check for the land board fixture (U149): its json() reads and manual-merged records now go to the box's warm worker thread,
 * except submit, verify, land and test, so a journey runs one sampled case twice, once with every journey CLI call a real process
 * and once in-process, and the exit codes, JSON results and board state must agree [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/add/split.test.js', cases: ['clause 2: split files each child after the previous one and the first after nothing [C7,#8916]'] }];

test('gate.journey-parity-land-board.a-land-board-sample-gives-the-same: clause 1: a land-board sample gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.journey-parity-land-board.the-land-board-fixture-starts-no-cli: clause 2: the land board fixture starts no CLI process for json() or manual merged records when the journey runs in-process [C7]', () => {
  const source = readFileSync(new URL('../../../apps/cli/tests/fixtures/land/board.js', import.meta.url), 'utf8');
  const quick = source.slice(source.indexOf('function quick('), source.indexOf('/** Run a successful JSON command'));
  assert.match(quick, /box\.runSync\(cwd, \.\.\.args\)/u, 'a quick command is answered on the worker thread');
  assert.match(quick, /JOURNEY_MODE === 'process'/u, 'PULLBOARD_JOURNEY_MODE=process still runs the real process');
  assert.match(source, /REAL_PROCESS = new Set\(\['submit', 'verify', 'land', 'test'/u, 'settling commands stay real');
  assert.doesNotMatch(source, /box\.run\(box\.repo, 'merged'/u, 'the merged record starts no CLI process');
  const json = source.slice(source.indexOf('export function json('), source.indexOf('export function json(') + 200);
  assert.doesNotMatch(json, /box\.run\(/u, 'json() starts no CLI process itself');
});
