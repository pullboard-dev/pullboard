/** The runner hand-off runs its stage commands through the runner's timed shell entry, not a bare /bin/sh [C7,E27]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../cli/tests/fixtures/child.js';
import { runHandoffStages } from '../../src/io/handoff.js';

const quiet = async () => {};
const noOtherStages = { authorization: quiet, doctrine: quiet, cells: quiet, composition: quiet, proof: quiet };

/** Run the criterion stage on a command and return the result with the runner log text. */
async function criterion(check) {
  const fixture = privateFixtureFiles('pb-handoff-');
  const logFile = join(fixture.root, 'runner.log');
  fixture.write('runner.log', '');
  const result = await runHandoffStages(fixture.root, { job: 'j1', commit: 'c1', check }, { logFile, services: {}, stages: noOtherStages });
  return { result, log: fixture.read('runner.log').toString('utf8') };
}

test('clause 1: a stage command runs under the timed shell entry, which sets the process-custody preload [C7,E27,#6906]', async () => {
  const { result, log } = await criterion('test -n "$PULLBOARD_RUNNER_PRELOAD" && echo custody-on');
  assert.equal(result.green, true);
  assert.match(log, /custody-on/u);
});

test('clause 1: a red stage command ends the job as GATE_RED with its output in the runner log [C7,#6906]', async () => {
  const { result, log } = await criterion('echo stage-line; exit 3');
  assert.equal(result.green, false);
  assert.equal(result.failed.code, 'GATE_RED');
  assert.match(log, /stage-line/u);
});
