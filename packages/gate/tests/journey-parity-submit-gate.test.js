/** @pullboard-test-input apps/cli/tests/io/submit/missing.test.js apps/cli/tests/fixtures/submit/gate.js apps/cli/tests/fixtures/e2e.js */
/** @pullboard-world-pin: clause 2 reads the committed submit gate fixture source to prove its quick CLI calls start no process. */
/**
 * The parity check for the submit gate fixture (U149): its setup calls (init, worktree, add, claim, fact) are answered by the warm
 * worker thread, while submit, verify, land, test and gate stay real processes. One sampled case runs twice, once with every call a
 * real process and once in-process, and the exit codes, JSON results and board state must agree [C7].
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { sampleDifferences } from './fixtures/journey-parity.js';

const SAMPLES = [{ journey: 'apps/cli/tests/io/submit/missing.test.js', cases: ['clause 1: submit refuses in under a second when the frozen check names a missing test file and lists the added files, with gate.refuseMissingCheckFile on [C7]'] }];

test('gate.journey-parity-submit-gate.a-submit-gate-fixture-sample-gives-the: clause 1: a submit gate fixture sample gives the same exit codes, JSON results and board state in a real process and in-process [C7]', async () => {
  const differences = await sampleDifferences(SAMPLES);
  assert.deepEqual(differences, [], `the two runtimes disagree:\n${differences.join('\n')}`);
});

test('gate.journey-parity-submit-gate.the-converted-submit-gate-fixture-calls-start: clause 2: the converted submit gate fixture calls start no CLI process when the journey runs in-process [C7]', () => {
  const source = readFileSync(new URL('../../../apps/cli/tests/fixtures/submit/gate.js', import.meta.url), 'utf8');
  const call = source.slice(source.indexOf('function fixtureCall'), source.indexOf('/** Create a private Git repository'));
  assert.match(call, /JOURNEY_MODE !== 'process' && !REAL_COMMANDS\.has\(args\[0\]\)/u, 'only a heavy command or process mode starts a process');
  assert.match(call, /quick \? runCliSync\(args, \{ cwd, env \}\)/u, 'a quick call is answered by the worker thread');
  assert.equal(source.match(/runFixtureChild\(process\.execPath/gu).length, 1, 'one real-process seam remains, inside fixtureCall');
  assert.match(source, /new Set\(\['submit', 'verify', 'land', 'test', 'gate'\]\)/u, 'the heavy commands stay real');
  assert.doesNotMatch(source.replace(call, ''), /runFixtureChild\(process\.execPath/u, 'run and builder run go through fixtureCall');
  assert.match(call, /PULLBOARD_PARITY_RECORD/u, 'each call appends its parity record');
});
