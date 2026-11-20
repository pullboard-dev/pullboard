/** serveRestartTrial() reads the serve.restartTrial machine setting: true only for an exact true [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { serveRestartTrial } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** What serveRestartTrial() answers for a private machine home holding the given settings, restoring the home afterwards. */
function trialWith(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-serve-restart-trial-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return serveRestartTrial();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-serve-restart-trial.accessor: clause 1: serveRestartTrial() is true only when serve.restartTrial is exactly true [C7]', () => {
  assert.equal(trialWith({}), false);
  assert.equal(trialWith({ serve: {} }), false);
  assert.equal(trialWith({ serve: { restartTrial: false } }), false);
  assert.equal(trialWith({ serve: { restartTrial: true } }), true);
  for (const other of ['true', 'yes', 1, null]) {
    let answer;
    try { answer = trialWith({ serve: { restartTrial: other } }); } catch { answer = false; }
    assert.equal(answer, false, `serve.restartTrial ${JSON.stringify(other)} is not on`);
  }
});
