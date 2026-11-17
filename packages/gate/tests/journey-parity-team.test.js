/** @pullboard-test-input apps/cli/journeys/decisions/project.test.js apps/cli/tests/fixtures/scenarios/team.js */
/** @pullboard-world-pin: clause 2 reads the committed team scenario fixture source to prove its quick calls start no CLI process in-process. */
/**
 * The parity check for the team scenario fixture (U149): its run() calls now go to the box's warm worker thread, except submit, verify,
 * land and test, so a team journey runs one light sampled case twice, once with every journey CLI call a real process and once in-process, and
 * the exit codes, JSON results and board state must agree [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/journeys/decisions/project.test.js', cases: ['two repos of a project that share a name are addressed by folder, never guessed [N34]'] }];

test('gate.journey-parity-team.a-team-fixture-sample-gives-the-same: clause 1: a team-fixture sample gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.journey-parity-team.the-team-fixture-run-starts-no-cli: clause 2: the team fixture run() starts no CLI process for a quick command when the journey runs in-process [C7]', () => {
  const source = readFileSync(new URL('../../../apps/cli/tests/fixtures/scenarios/team.js', import.meta.url), 'utf8');
  const quick = source.slice(source.indexOf('function quick('), source.indexOf('/** Run a fixture CLI command'));
  assert.match(quick, /box\.runSync\(root, \.\.\.args\)/u, 'a quick command is answered on the worker thread');
  assert.match(quick, /JOURNEY_MODE === 'process'/u, 'PULLBOARD_JOURNEY_MODE=process still runs the real process');
  assert.match(source, /REAL_PROCESS = new Set\(\['submit', 'verify', 'land', 'test'/u, 'settling commands stay real');
  const runHelper = source.slice(source.indexOf('function run(box'), source.indexOf('function run(box') + 300);
  assert.doesNotMatch(runHelper, /box\.run\(/u, 'run() does not start a CLI process itself');
  assert.doesNotMatch(source, /box\.run\(repo, 'init'\)/u, 'siblingRepo init does not start a CLI process');
});
