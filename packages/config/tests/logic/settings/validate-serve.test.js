/** validateServe takes serve.restartTrial as a boolean and keeps the other serve keys as they were [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachineSettings } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** The serve settings loaded from a private machine home holding the given settings, restoring the home afterwards. */
function loadServe(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-validate-serve-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return loadMachineSettings().serve;
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.logic-settings-validate-serve.restart-trial-boolean: clause 1: serve.restartTrial is accepted as a boolean and any other value is refused [C7]', () => {
  assert.equal(loadServe({ serve: { restartTrial: true } }).restartTrial, true);
  assert.equal(loadServe({ serve: { restartTrial: false } }).restartTrial, false);
  for (const other of ['true', 1, null]) {
    assert.throws(() => loadServe({ serve: { restartTrial: other } }), { code: 'BAD_MACHINE_SETTINGS' }, `serve.restartTrial ${JSON.stringify(other)} is refused`);
  }
  assert.equal(loadServe({ serve: { pullRoute: true, port: 0 } }).pullRoute, true);
  assert.throws(() => loadServe({ serve: { pullRoute: 'yes' } }), { code: 'BAD_MACHINE_SETTINGS' });
  assert.throws(() => loadServe({ serve: { other: 1 } }), { code: 'BAD_MACHINE_SETTINGS' });
});
